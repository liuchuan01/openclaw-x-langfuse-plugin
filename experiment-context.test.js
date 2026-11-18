import { test } from "node:test";
import assert from "node:assert/strict";
import { readExperimentContext } from "./experiment-context.js";

function headers(extra = {}) {
  const entries = {
    "langfuse.experiment.id": "experiment-a",
    "langfuse.experiment.name": "Regression 中文",
    "langfuse.experiment.item.id": "item-a",
    "langfuse.experiment.item.root_observation_id": "2222222222222222",
    ...extra,
  };
  return {
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    baggage: Object.entries(entries).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join(","),
  };
}

test("extracts remote parent and allowlisted experiment and metadata baggage", () => {
  const result = readExperimentContext(headers({
    langfuse_metadata_run_code: "run-a", langfuse_environment: "experiment",
    "langfuse.experiment.metadata": '{"knowledge_version":"v1"}',
    authorization: "secret", "langfuse.experiment.expected_output": "answer",
  }));
  assert.equal(result.parentSpanContext.traceId, "11111111111111111111111111111111");
  assert.equal(result.parentSpanContext.isRemote, true);
  assert.equal(result.attributes["langfuse.experiment.name"], "Regression 中文");
  assert.equal(result.attributes["langfuse.trace.metadata.run_code"], "run-a");
  assert.equal(result.attributes["langfuse.environment"], "experiment");
  assert.equal(Object.keys(result.attributes).length, 7);
});

test("supports underscore SDK aliases without changing the experiment identity", () => {
  const request = headers();
  request.baggage = request.baggage.replaceAll("langfuse.experiment.", "langfuse_experiment_")
    .replace("item.id", "item_id").replace("item.root_observation_id", "item_root_observation_id");
  assert.equal(readExperimentContext(request).attributes["langfuse.experiment.item.id"], "item-a");
});

for (const [name, change] of [
  ["missing traceparent", (h) => delete h.traceparent],
  ["zero trace id", (h) => h.traceparent = h.traceparent.replaceAll("1", "0")],
  ["oversized baggage", (h) => h.baggage = "a".repeat(8193)],
  ["missing experiment", (h) => h.baggage = "other=value"],
  ["zero root observation", (h) => h.baggage = h.baggage.replace("2222222222222222", "0000000000000000")],
  ["conflicting aliases", (h) => h.baggage += ",langfuse_experiment_id=other"],
  ["invalid JSON metadata", (h) => h.baggage += ",langfuse.experiment.metadata=broken"],
  ["array metadata", (h) => h.baggage += ",langfuse.experiment.metadata=%5B%5D"],
  ["reserved environment", (h) => h.baggage += ",langfuse_environment=langfuse-test"],
]) {
  test(`rejects ${name}`, () => {
    const request = headers();
    change(request);
    assert.throws(() => readExperimentContext(request), (error) => error.status === 400);
  });
}

test("Python OTel baggage normalized to percent-encoded spaces preserves literal plus signs", () => {
  const request = headers();
  // Python's quote_plus encodes spaces as + and literal + as %2B. The caller
  // normalizes + to %20 before sending, as shown in examples/experiment.py.
  request.baggage += ',langfuse.experiment.metadata=%7B%22version%22%3A+%22C%2B%2B+v1%22%7D'.replaceAll("+", "%20");
  const actual = readExperimentContext(request).attributes["langfuse.experiment.metadata"];
  assert.deepEqual(JSON.parse(actual), { version: "C++ v1" });
});
