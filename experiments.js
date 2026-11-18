// Optional, Gateway-authenticated entrypoint for remote SDK experiments. The
// route lives in OpenClaw; it is not an OTLP receiver or a separate service.
import { randomUUID } from "node:crypto";
import { readExperimentContext, ExperimentRequestError } from "./experiment-context.js";
import { createExperimentTrace, EXPERIMENT_HOOKS } from "./experiment-tracer.js";

export const EXPERIMENT_PATH = "/plugins/langfuse-bridge/experiments/run";
const MAX_BODY_BYTES = 64 * 1024;
const RETAIN_MS = 5 * 60_000;

async function withAbort(promise, signal) {
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function readBody(req, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    function finish(error, value) {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (error) { req.resume(); reject(error); }
      else resolve(value);
    }
    function onData(chunk) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) return finish(new ExperimentRequestError(413, "Request body is too large"));
      chunks.push(Buffer.from(chunk));
    }
    function onEnd() {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return finish(new ExperimentRequestError(400, "Invalid JSON body")); }
      finish(null, body);
    }
    function onError(error) { finish(error); }
    function onAbort() { finish(signal.reason); }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** OpenClaw is injected, like the tracing surface in tracer.js, so lifecycle,
 * isolation and HTTP failures can be tested without booting a Gateway.
 */
export function createExperiments(api, config, opts = {}) {
  const now = opts.now ?? Date.now;
  const createSession = opts.createSession ?? (async (workspaceDir) => {
    const { SessionManager } = await import("openclaw/plugin-sdk/agent-sessions");
    return SessionManager.inMemory(workspaceDir);
  });
  const allowedAgents = config.allowedAgents ?? ["main"];
  const timeoutMs = config.timeoutMs ?? 120_000;
  const maxConcurrentRuns = config.maxConcurrentRuns ?? 4;
  let tracing = null;
  let stopped = false;
  const active = new Map();
  const retained = new Map(); // suppress late diagnostics for completed evals

  function keys(evt) {
    return [evt?.runId && `run:${evt.runId}`, evt?.sessionId && `session:${evt.sessionId}`,
      evt?.trace?.traceId && `trace:${evt.trace.traceId}`].filter(Boolean);
  }
  function remember(run, evt) {
    for (const key of keys(evt)) run.keys.add(key);
  }
  function ownsDiagnostic(evt) {
    const eventKeys = keys(evt);
    for (const run of active.values()) {
      if (eventKeys.some((key) => run.keys.has(key))) {
        remember(run, evt);
        return true;
      }
    }
    for (const [key, expires] of retained) if (expires <= now()) retained.delete(key);
    return eventKeys.some((key) => retained.has(key));
  }

  for (const name of EXPERIMENT_HOOKS) {
    api.on(name, (evt, ctx) => {
      const run = active.get(ctx?.runId ?? evt?.runId);
      if (!run?.trace) return;
      remember(run, evt);
      remember(run, ctx);
      try { run.trace.handle(name, { ...evt, toolCallId: evt.toolCallId ?? ctx?.toolCallId }); }
      catch (err) { api.logger.warn(`langfuse-bridge: experiment hook ${name} failed: ${String(err)}`); }
    });
  }

  async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      send(res, 405, { error: "Use POST" });
      return true;
    }
    if (!tracing || stopped) {
      send(res, 503, { error: "Langfuse experiment service is not ready" });
      return true;
    }
    if (active.size >= maxConcurrentRuns) {
      send(res, 429, { error: "Too many concurrent experiment runs" });
      return true;
    }
    const runId = randomUUID();
    const controller = new AbortController();
    const run = { controller, keys: new Set([`run:${runId}`]), trace: null };
    run.done = new Promise((resolve) => { run.resolve = resolve; });
    active.set(runId, run); // reserve admission before reading an async body
    const timer = setTimeout(() => controller.abort(new ExperimentRequestError(504, "Experiment run timed out")), timeoutMs);
    timer.unref?.();
    const onClose = () => { if (!res.writableEnded) controller.abort(new ExperimentRequestError(499, "Client disconnected")); };
    res.on("close", onClose);
    const onAborted = () => controller.abort(new ExperimentRequestError(499, "Client disconnected"));
    req.on("aborted", onAborted);
    try {
      const upstream = readExperimentContext(req.headers);
      const body = await readBody(req, controller.signal);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some((key) => !["question", "agent_id"].includes(key)) ||
          typeof body.question !== "string" || !body.question.trim()) {
        throw new ExperimentRequestError(400, "Expected question and optional agent_id");
      }
      const agentId = body.agent_id ?? "main";
      if (typeof agentId !== "string" || !allowedAgents.includes(agentId)) {
        throw new ExperimentRequestError(403, "Agent is not enabled for experiments");
      }
      const cfg = api.runtime.config?.current?.() ?? api.config;
      const configuredAgents = cfg.agents?.list;
      if (configuredAgents?.length ? !configuredAgents.some((agent) => agent.id === agentId) : agentId !== "main") {
        throw new ExperimentRequestError(404, "Agent is not configured");
      }
      const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
      const sessionManager = await withAbort(createSession(workspaceDir), controller.signal);
      controller.signal.throwIfAborted();
      const sessionId = sessionManager.getSessionId();
      remember(run, { sessionId });
      run.trace = createExperimentTrace(tracing, { ...upstream, question: body.question, runId, agentId }, { now });
      // A fresh in-memory transcript keeps cases independent while using the
      // selected agent's actual configuration, workspace, tools and harness.
      const execution = api.runtime.agent.runEmbeddedAgent({
        prompt: body.question, agentId, runId, sessionId, workspaceDir,
        agentDir: api.runtime.agent.resolveAgentDir(cfg, agentId), config: cfg,
        timeoutMs, abortSignal: controller.signal, sessionManager,
        sessionPersistence: "detached", terminalReplyExpectation: "result-required",
      });
      const result = await withAbort(execution, controller.signal);
      controller.signal.throwIfAborted();
      if (result.meta?.aborted || result.meta?.error) throw new Error("Agent execution did not complete");
      const answer = (result.payloads ?? []).filter((payload) => typeof payload.text === "string")
        .map((payload) => payload.text).join("\n");
      if (!answer.trim()) throw new Error("Agent returned no answer");
      const response = run.trace.finish({ answer, messages: sessionManager.buildSessionContext().messages });
      send(res, 200, response);
    } catch (err) {
      run.trace?.finish({ error: String(err.message ?? err) });
      if (!(err instanceof ExperimentRequestError)) api.logger.warn(`langfuse-bridge: experiment run failed: ${String(err)}`);
      send(res, err instanceof ExperimentRequestError ? err.status : 500, { error: err instanceof ExperimentRequestError ? err.message : "Agent execution failed",
        ...(run.trace ? { trace_id: run.trace.root.traceId } : {}) });
    } finally {
      clearTimeout(timer);
      req.off("aborted", onAborted);
      res.off("close", onClose);
      for (const key of run.keys) retained.set(key, now() + RETAIN_MS);
      while (retained.size > 10_000) retained.delete(retained.keys().next().value);
      active.delete(runId);
      run.resolve();
    }
    return true;
  }

  api.registerHttpRoute({ path: EXPERIMENT_PATH, auth: "gateway", match: "exact", handler });
  return {
    ownsDiagnostic,
    start(surface) { tracing = surface; stopped = false; },
    async stop() {
      stopped = true;
      for (const run of active.values()) run.controller.abort(new ExperimentRequestError(503, "Gateway is stopping"));
      await Promise.all([...active.values()].map((run) => run.done));
      tracing = null;
      retained.clear();
    },
  };
}
