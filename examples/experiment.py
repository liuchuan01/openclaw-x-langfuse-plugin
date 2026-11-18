"""Run a Langfuse SDK experiment against an existing OpenClaw Gateway.

pip install 'langfuse==5.2.0' requests
Export LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL,
OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN before running this script.
"""
import os
from datetime import datetime, timezone

import requests
from langfuse import Evaluation, get_client, propagate_attributes
from opentelemetry import baggage, context, propagate, trace


def request_headers():
    # SDK 5.2 sets experiment attributes on the task span, but does not inject
    # them into outbound baggage. Copy the SDK-generated values using public
    # OTel APIs; no second experiment or manually generated identifiers.
    ctx = context.get_current()
    span = trace.get_current_span()
    for key, value in span.attributes.items():
        if key.startswith("langfuse.experiment.") and key != "langfuse.experiment.item.expected_output":
            ctx = baggage.set_baggage(key, str(value), context=ctx)
    headers = {}
    propagate.inject(headers, context=ctx)
    # Python OTel uses quote_plus; JS W3C extraction uses decodeURIComponent.
    # Literal plus signs are already %2B, so normalize encoded spaces only.
    if "baggage" in headers:
        headers["baggage"] = headers["baggage"].replace("+", "%20")
    headers["Authorization"] = "Bearer " + os.environ["OPENCLAW_GATEWAY_TOKEN"]
    return headers


def main():
    client = get_client()
    run_code = "openclaw-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    metadata = {
        "run_code": run_code,
        "knowledge_version": os.environ.get("KNOWLEDGE_VERSION", "example-v1"),
    }

    def task(*, item, **kwargs):
        with propagate_attributes(metadata=metadata, environment="experiment", as_baggage=True):
            trace_id = format(trace.get_current_span().get_span_context().trace_id, "032x")
            response = requests.post(
                os.environ["OPENCLAW_GATEWAY_URL"].rstrip("/")
                + "/plugins/langfuse-bridge/experiments/run",
                headers=request_headers(),
                json={"question": item["input"], "agent_id": os.environ.get("OPENCLAW_AGENT_ID", "main")},
                timeout=150,
            )
            response.raise_for_status()
            result = response.json()
            if result["trace_id"] != trace_id:
                raise RuntimeError("OpenClaw did not continue the SDK task trace")
            return result["answer"]

    def exact_match(*, output, expected_output, **kwargs):
        return Evaluation(name="exact_match", value=float(output.strip() == expected_output))

    try:
        result = client.run_experiment(
            name=run_code,
            data=[{"input": "What is 2 + 2? Reply with only the number.", "expected_output": "4"}],
            task=task,
            evaluators=[exact_match],
            metadata=metadata,
            max_concurrency=2,
        )
        print(result.format())
    finally:
        client.flush()


if __name__ == "__main__":
    main()
