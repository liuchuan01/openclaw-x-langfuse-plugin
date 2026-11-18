import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { createExperimentTrace } from "./experiment-tracer.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
setLangfuseTracerProvider(provider);

function make(id = "a") {
  return createExperimentTrace({ startObservation }, {
    question: "Read the facts", runId: id, agentId: "main",
    parentSpanContext: { traceId: id.repeat(32), spanId: "2222222222222222", traceFlags: 1, isRemote: true },
    attributes: { "langfuse.experiment.id": id, "langfuse.trace.metadata.run_code": `run-${id}` },
  });
}
function spans(run) { return exporter.getFinishedSpans().filter((s) => s.spanContext().traceId === run.root.traceId); }

test("real Langfuse SDK preserves remote trace ancestry, IO and attributes on every step", () => {
  const run = make();
  run.handle("model_call_started", { callId: "m1", model: "test-model" });
  run.handle("model_call_ended", { callId: "m1", outcome: "completed" });
  run.handle("before_tool_call", { toolCallId: "t1", toolName: "read", params: { path: "facts.txt" } });
  run.handle("after_tool_call", { toolCallId: "t1", result: "ORCHID-27" });
  const result = run.finish({ answer: "ORCHID-27", messages: [
    { role: "user", content: "Read the facts" },
    { role: "assistant", content: "ORCHID-27", usage: { input: 10, output: 4, total: 14 } },
  ] });
  assert.equal(result.model_io_matched, true);
  assert.equal(result.trace_id, "a".repeat(32));
  const actual = spans(run);
  assert.equal(actual.length, 3);
  const root = actual.find((s) => s.name === "openclaw experiment");
  assert.equal(root.parentSpanContext.spanId, "2222222222222222");
  for (const span of actual) {
    assert.equal(span.attributes["langfuse.experiment.id"], "a");
    assert.equal(span.attributes["langfuse.trace.metadata.run_code"], "run-a");
    if (span !== root) assert.equal(span.parentSpanContext.spanId, root.spanContext().spanId);
  }
  const generation = actual.find((s) => s.name === "model.call");
  assert.match(generation.attributes["langfuse.observation.output"], /ORCHID-27/);
  assert.equal(JSON.parse(generation.attributes["langfuse.observation.usage_details"]).input, 10);
  assert.equal(run.finish({ answer: "duplicate" }), undefined);
  assert.equal(spans(run).length, 3);
});

test("overlapping calls with identical hook IDs stay isolated and nest explicit Code Mode tools", () => {
  const a = make("b");
  const b = make("c");
  for (const run of [a, b]) {
    run.handle("before_tool_call", { toolCallId: "t1", toolName: "exec", params: {} });
    run.handle("before_tool_call", { toolCallId: "tool_call:t1:read", toolName: "read", params: {} });
  }
  a.handle("after_tool_call", { toolCallId: "tool_call:t1:read", result: "a" });
  b.handle("after_tool_call", { toolCallId: "tool_call:t1:read", error: "failed" });
  a.finish({ answer: "a" });
  b.finish({ error: "b failed" });
  for (const run of [a, b]) {
    const actual = spans(run);
    assert.equal(actual.length, 3);
    assert.equal(actual.find((s) => s.name === "read").parentSpanContext.spanId,
      actual.find((s) => s.name === "exec").spanContext().spanId);
    assert.equal(actual.find((s) => s.name === "exec").attributes["langfuse.observation.level"], "ERROR");
    assert.ok(actual.every((s) => s.attributes["langfuse.experiment.id"] === run.root.traceId[0]));
  }
});

test("retries and missing terminal hooks do not receive fabricated per-call IO", () => {
  const run = make("d");
  run.handle("model_call_started", { callId: "m1" });
  run.handle("model_call_ended", { callId: "m1", outcome: "error" });
  run.handle("model_call_started", { callId: "m2" });
  const result = run.finish({ answer: "answer", messages: [{ role: "assistant", content: "answer" }] });
  assert.equal(result.model_io_matched, false);
  for (const span of spans(run).filter((s) => s.name === "model.call")) {
    assert.equal(span.attributes["langfuse.observation.output"], undefined);
    assert.equal(span.attributes["langfuse.observation.level"], "ERROR");
  }
});
