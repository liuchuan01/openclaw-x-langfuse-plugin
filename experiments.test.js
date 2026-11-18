import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { NodeTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { startObservation, setLangfuseTracerProvider } from "@langfuse/tracing";
import { createExperiments, EXPERIMENT_PATH } from "./experiments.js";

const exporter = new InMemorySpanExporter();
setLangfuseTracerProvider(new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
function headers(id = "a") {
  return { traceparent: `00-${id.repeat(32)}-2222222222222222-01`, baggage:
    `langfuse.experiment.id=${id},langfuse.experiment.name=test,langfuse.experiment.item.id=item-${id},langfuse.experiment.item.root_observation_id=2222222222222222,langfuse_metadata_run_code=run-${id}` };
}
async function fixture(t, config = {}, execute) {
  const hooks = {};
  const calls = [];
  let route;
  const api = {
    config: { agents: { list: [{ id: "main" }] } }, logger: { warn() {} },
    on(name, handler) { hooks[name] = handler; },
    registerHttpRoute(value) { route = value; },
    runtime: { agent: {
      resolveAgentWorkspaceDir: () => "/workspace", resolveAgentDir: () => "/agent",
      async runEmbeddedAgent(params) {
        calls.push(params);
        if (execute) return execute(params, hooks);
        hooks.model_call_started({ callId: "shared", model: "test" }, { runId: params.runId });
        await new Promise((resolve) => setTimeout(resolve, 10));
        hooks.model_call_ended({ callId: "shared", outcome: "completed" }, { runId: params.runId });
        return { payloads: [{ text: params.prompt }] };
      },
    } },
  };
  const service = createExperiments(api, config, { createSession: async () => ({
    getSessionId: () => randomUUID(), buildSessionContext: () => ({ messages: [] }),
  }) });
  const server = createServer((req, res) => route.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await service.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}${EXPERIMENT_PATH}`;
  async function post(body = { question: "same question" }, requestHeaders = headers()) {
    const response = await fetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { service, calls, route, url, post };
}

test("route requires Gateway auth and refuses calls until exporter is ready", async (t) => {
  const f = await fixture(t);
  assert.equal(f.route.auth, "gateway");
  assert.equal(f.route.match, "exact");
  assert.equal((await f.post()).status, 503);
  f.service.start({ startObservation });
  assert.equal((await fetch(f.url)).status, 405);
  assert.equal((await f.post({}, {})).status, 400);
  assert.equal((await f.post({ question: "q", expected_output: "secret" })).status, 400);
  assert.equal((await f.post({ question: "q", agent_id: "other" })).status, 403);
  assert.equal(f.calls.length, 0);
});

test("concurrent identical questions preserve caller experiment and use detached sessions", async (t) => {
  const f = await fixture(t);
  f.service.start({ startObservation });
  const results = await Promise.all([f.post(undefined, headers("a")), f.post(undefined, headers("b"))]);
  for (const [i, id] of ["a", "b"].entries()) {
    assert.equal(results[i].status, 200);
    assert.equal(results[i].body.trace_id, id.repeat(32));
    const spans = exporter.getFinishedSpans().filter((s) => s.spanContext().traceId === id.repeat(32));
    assert.equal(spans.length, 2);
    assert.ok(spans.every((s) => s.attributes["langfuse.experiment.id"] === id));
  }
  assert.notEqual(f.calls[0].sessionId, f.calls[1].sessionId);
  for (const call of f.calls) {
    assert.equal(call.sessionPersistence, "detached");
    assert.equal(call.workspaceDir, "/workspace");
    assert.equal(f.service.ownsDiagnostic({ sessionId: call.sessionId }), true);
    assert.equal(f.service.ownsDiagnostic({ runId: call.runId }), true);
  }
  assert.equal(f.service.ownsDiagnostic({ runId: "ordinary-chat" }), false);
});

test("timeout aborts execution, closes spans and releases admission", async (t) => {
  const f = await fixture(t, { timeoutMs: 40, maxConcurrentRuns: 1 }, async () => new Promise(() => {}));
  f.service.start({ startObservation });
  const first = f.post(undefined, headers("c"));
  while (!f.calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await f.post()).status, 429);
  assert.equal((await first).status, 504);
  assert.equal(f.calls[0].abortSignal.aborted, true);
  assert.equal((await f.post(undefined, headers("d"))).status, 504);
  const root = exporter.getFinishedSpans().find((s) => s.spanContext().traceId === "c".repeat(32));
  assert.equal(root.attributes["langfuse.observation.level"], "ERROR");
});

test("shutdown aborts active work and prevents new admission", async (t) => {
  const f = await fixture(t, {}, async () => new Promise(() => {}));
  f.service.start({ startObservation });
  const pending = f.post(undefined, headers("e"));
  while (!f.calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
  await f.service.stop();
  assert.equal((await pending).status, 503);
  assert.equal(f.calls[0].abortSignal.aborted, true);
  assert.equal((await f.post()).status, 503);
});

test("agent failures return a trace id without leaking internal error details", async (t) => {
  const f = await fixture(t, {}, async () => { throw new Error("provider secret detail"); });
  f.service.start({ startObservation });
  const result = await f.post(undefined, headers("f"));
  assert.equal(result.status, 500);
  assert.equal(result.body.error, "Agent execution failed");
  assert.equal(result.body.trace_id, "f".repeat(32));
});

test("invalid JSON and oversized bodies fail before invoking the agent", async (t) => {
  const f = await fixture(t);
  f.service.start({ startObservation });
  for (const [body, status] of [["{", 400], [JSON.stringify({ question: "x".repeat(65536) }), 413]]) {
    const response = await fetch(f.url, { method: "POST", headers: headers(), body });
    assert.equal(response.status, status);
    await response.text();
  }
  assert.equal(f.calls.length, 0);
});

test("client disconnect aborts the corresponding run", async (t) => {
  const f = await fixture(t, {}, async () => new Promise(() => {}));
  f.service.start({ startObservation });
  const controller = new AbortController();
  const pending = fetch(f.url, { method: "POST", headers: headers(), body: '{"question":"q"}', signal: controller.signal });
  while (!f.calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host signal was not aborted")), 1000);
    const signal = f.calls[0].abortSignal;
    const done = () => { clearTimeout(timer); resolve(); };
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
});
