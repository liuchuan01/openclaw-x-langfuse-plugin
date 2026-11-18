// Request-scoped experiment attributes. Never use a process-global "current
// experiment": concurrent requests can belong to different SDK runs.
import { ROOT_CONTEXT, propagation, trace, defaultTextMapGetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator, W3CBaggagePropagator } from "@opentelemetry/core";

export class ExperimentRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EXPERIMENT_KEYS = new Map([
  ["id", "id"], ["name", "name"], ["metadata", "metadata"],
  ["dataset_id", "dataset.id"], ["item_id", "item.id"],
  ["item_metadata", "item.metadata"], ["item_version", "item.version"],
  ["item_root_observation_id", "item.root_observation_id"],
]);
const JSON_KEYS = new Set(["langfuse.experiment.metadata", "langfuse.experiment.item.metadata"]);
const NONZERO_SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;

/** Accept official dotted OTel attributes and the SDK's langfuse_* baggage. */
export function readExperimentContext(headers) {
  for (const key of ["traceparent", "baggage"]) {
    if (typeof headers[key] !== "string" || !headers[key] || Buffer.byteLength(headers[key]) > 8192) {
      throw new ExperimentRequestError(400, `A bounded ${key} header is required`);
    }
  }
  let ctx = new W3CTraceContextPropagator().extract(ROOT_CONTEXT, headers, defaultTextMapGetter);
  ctx = new W3CBaggagePropagator().extract(ctx, headers, defaultTextMapGetter);
  const parentSpanContext = trace.getSpanContext(ctx);
  if (!parentSpanContext?.isRemote) throw new ExperimentRequestError(400, "Invalid traceparent");

  const attributes = {};
  for (const [key, { value }] of propagation.getBaggage(ctx)?.getAllEntries() ?? []) {
    let target;
    if (key.startsWith("langfuse_experiment_")) {
      const suffix = EXPERIMENT_KEYS.get(key.slice("langfuse_experiment_".length));
      if (suffix) target = `langfuse.experiment.${suffix}`;
    } else if ([...EXPERIMENT_KEYS.values()].some((suffix) => key === `langfuse.experiment.${suffix}`)) {
      target = key;
    } else if (/^langfuse\.experiment\.(?:item\.)?metadata\.[\w.-]+$/.test(key)) {
      target = key;
    } else if (/^langfuse_metadata_[\w.-]+$/.test(key)) {
      target = `langfuse.trace.metadata.${key.slice("langfuse_metadata_".length)}`;
    } else if (/^langfuse\.trace\.metadata\.[\w.-]+$/.test(key)) {
      target = key;
    } else if (key === "langfuse_environment" || key === "langfuse.environment") {
      target = "langfuse.environment";
      if (!/^(?!langfuse)[a-z0-9_-]{1,40}$/.test(value)) throw new ExperimentRequestError(400, "Invalid environment");
    }
    if (!target) continue; // Do not forward unrelated baggage, credentials or IO.
    if (!value || Buffer.byteLength(value) > 4096) throw new ExperimentRequestError(400, "Invalid experiment attribute");
    if (JSON_KEYS.has(target)) {
      let decoded;
      try { decoded = JSON.parse(value); } catch { /* validated below */ }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new ExperimentRequestError(400, "Experiment metadata must be a JSON object");
      }
    }
    if (attributes[target] !== undefined && attributes[target] !== value) {
      throw new ExperimentRequestError(400, "Conflicting experiment attributes");
    }
    attributes[target] = value;
  }
  for (const key of ["id", "name", "item.id", "item.root_observation_id"]) {
    if (!attributes[`langfuse.experiment.${key}`]) throw new ExperimentRequestError(400, `Missing experiment ${key}`);
  }
  if (!NONZERO_SPAN_ID.test(attributes["langfuse.experiment.item.root_observation_id"])) {
    throw new ExperimentRequestError(400, "Invalid experiment item root observation id");
  }
  return { parentSpanContext, attributes };
}
