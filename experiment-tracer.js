// Hook-based observations for a single plugin-owned evaluation turn. Ordinary
// channel traffic continues through the diagnostic engine in tracer.js.
import { compact, classifyToolType, generationAttributes, toolAttributes, usageDetails, toDate } from "./mapping.js";

export const EXPERIMENT_HOOKS = [
  "model_call_started", "model_call_ended", "before_tool_call", "after_tool_call",
];

export function createExperimentTrace(tracing, request, opts = {}) {
  const now = opts.now ?? Date.now;
  const models = new Map();
  const tools = new Map();
  const observations = [];
  let finished = false;

  function inherit(obs) {
    for (const [key, value] of Object.entries(request.attributes)) obs.otelSpan.setAttribute(key, value);
    observations.push(obs);
    return obs;
  }
  const root = inherit(tracing.startObservation("openclaw experiment", {
    input: request.question, metadata: { runId: request.runId, agentId: request.agentId },
  }, { asType: "agent", parentSpanContext: request.parentSpanContext }));

  function end(entry, error) {
    if (entry.ended) return;
    if (error) entry.obs.update({ level: "ERROR", statusMessage: error });
    entry.obs.end(toDate(entry.endMs ?? now()));
    entry.ended = true;
  }

  function handle(name, evt) {
    if (finished) return;
    if (name === "model_call_started" && evt.callId && !models.has(evt.callId)) {
      models.set(evt.callId, { obs: inherit(root.startObservation("model.call", generationAttributes(evt), { asType: "generation" })) });
    } else if (name === "model_call_ended") {
      const entry = models.get(evt.callId);
      if (!entry || entry.endMs !== undefined) return;
      entry.endMs = now();
      entry.outcome = evt.outcome;
      entry.obs.update({ metadata: compact({ outcome: evt.outcome, durationMs: evt.durationMs }) });
      if (evt.outcome !== "success" && evt.outcome !== "completed") {
        entry.obs.update({ level: "ERROR", statusMessage: evt.outcome ?? "Unknown model outcome" });
      }
    } else if (name === "before_tool_call" && evt.toolCallId && !tools.has(evt.toolCallId)) {
      // Code Mode explicitly embeds its parent invocation id in nested calls.
      // Do not guess parentage from timestamps or a mutable "current tool".
      const parent = [...tools.entries()]
        .filter(([id, entry]) => !entry.ended && evt.toolCallId.startsWith(`tool_call:${id}:`))
        .sort(([a], [b]) => b.length - a.length)[0]?.[1]?.obs ?? root;
      tools.set(evt.toolCallId, { obs: inherit(parent.startObservation(evt.toolName, {
        ...toolAttributes(evt), input: evt.params,
      }, { asType: classifyToolType(evt.toolName) })) });
    } else if (name === "after_tool_call") {
      const entry = tools.get(evt.toolCallId);
      if (!entry || entry.ended) return;
      entry.obs.update({ output: evt.result ?? evt.error, metadata: compact({ durationMs: evt.durationMs }) });
      end(entry, evt.error ? String(evt.error) : undefined);
    }
  }

  /** The transcript belongs to this fresh session, not a prior conversation.
   * Only assign per-call IO when all calls succeeded and align one-to-one with
   * assistant messages. Retries/fallbacks must not acquire fabricated outputs.
   */
  function finish({ answer, messages = [], error } = {}) {
    if (finished) return;
    finished = true;
    const assistants = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "assistant");
    const aligned = models.size > 0 && assistants.length === models.size && [...models.values()].every((entry) =>
      entry.endMs !== undefined && ["success", "completed"].includes(entry.outcome));
    let index = 0;
    for (const entry of models.values()) {
      if (aligned) {
        const { message, index: messageIndex } = assistants[index++];
        entry.obs.update(compact({
          input: messages.slice(0, messageIndex), output: message.content,
          usageDetails: message.usage ? usageDetails(message.usage) : undefined,
          metadata: { inputSource: "session-transcript" },
        }));
      } else {
        entry.obs.update({ metadata: { ioUnavailable: "Provider calls do not align with assistant messages" } });
      }
      end(entry, error ?? (entry.endMs === undefined ? "Missing model terminal hook" : undefined));
    }
    for (const entry of tools.values()) end(entry, error ?? "Missing tool terminal hook");
    root.update(compact({ output: answer, level: error ? "ERROR" : undefined, statusMessage: error }));
    root.end();
    return { answer, trace_id: root.traceId, observation_id: root.id, model_io_matched: aligned };
  }

  return { handle, finish, root, observations };
}
