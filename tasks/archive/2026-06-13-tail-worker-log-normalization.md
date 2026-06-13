# Tail Worker Log Normalization Hardening

## Problem

The Tail Worker log forwarding path can throw or forward malformed schema data before the intended fail-safe forwarding guard runs. A malformed Cloudflare `TraceItem` log payload can abort the tail invocation, and structured JSON fields can override normalized levels or string fields with untrusted runtime values.

## Research Findings

- `apps/tail-worker/src/index.ts` normalizes logs before the forwarding `try/catch`; `log.message.join(' ')` and `new Date(log.timestamp).toISOString()` can throw before the "tail workers must not throw" guard.
- Structured JSON parsing currently assigns `json.message`, `json.event`, and `json.level` without runtime type checks. This can violate the `TailWorkerEvent` contract and forward arbitrary levels such as `debug`.
- `ACCEPTED_LEVELS` is intended to limit forwarded levels to `error`, `warn`, and `info`; console `log`/`info` map to `info`, while `debug`/`trace` are skipped.
- `apps/tail-worker/tests/unit/tail-handler.test.ts` uses broad `any` fixtures and does not cover adversarial timestamp/message/structured JSON shapes.
- `apps/tail-worker/tests/unit/subscriber-gate.test.ts` already verifies body consumption, zero-subscriber TTL gating, and fail-open behavior for thrown fetches and plain-text 500 responses, but not a non-2xx JSON body containing `{ "subscribers": 0 }`.
- `apps/api/src/routes/observability-ingest.ts` buffers the AdminLogs DO response and returns its status/body. The tail worker should consume the body for both success and failure, but only successful ingest responses should update the subscriber cache.
- `apps/api/src/durable-objects/admin-logs.ts` parses tail-worker entries defensively, but the tail worker still owns the outbound runtime contract.
- Prior observability task `tasks/archive/2026-05-04-fix-tail-worker-ingest-auth.md` split ingest auth for service-binding calls; this task should not change ingest auth.
- Prior commit `ab20fdbf` added subscriber-aware gating to prevent the AdminLogs firehose; this task must preserve the zero-subscriber TTL gate while failing open on unsuccessful or malformed ingest responses.

## Post-Mortem

### What Broke

The Tail Worker could abort a tail invocation while normalizing malformed log input, despite comments stating tail workers must not throw. It could also forward runtime-invalid `level`, `message`, and `event` values from structured JSON and arm the zero-subscriber gate from a failed ingest response that happened to contain `{ "subscribers": 0 }`.

### Root Cause

Normalization trusted Cloudflare trace payload shapes and structured JSON fields before validating runtime types. The subscriber cache update trusted parsed response content without checking `response.ok`.

### Timeline

- `7c485515` introduced the Tail Worker as part of the admin observability dashboard.
- `ab20fdbf` added subscriber gating and response-body consumption to stop the AdminLogs firehose.
- The CTO spot check identified the remaining adversarial normalization and failed-ingest cache hazards on 2026-06-13.

### Why It Was Not Caught

Existing tests covered normal log forwarding, basic level filtering, and common subscriber-gate behavior, but used permissive fixtures and did not exercise malformed trace payloads, non-string structured fields, structured level override abuse, or failed JSON ingest responses.

### Class Of Bug

Boundary normalization drift: runtime data crossing a platform boundary was treated as if TypeScript assertions made it safe, and a cache was updated from an unsuccessful cross-service response.

### Process Fix

Add focused regression tests for adversarial boundary payloads and failed-response cache behavior in this slice. The implementation checklist below requires validating untrusted trace/JSON values before they enter the outbound `TailWorkerEvent` contract.

## Implementation Checklist

- [x] Add local helpers in `apps/tail-worker/src/index.ts` for console-level normalization, structured-level validation, safe non-empty string extraction, safe message joining, safe timestamp formatting, and successful subscriber-count extraction.
- [x] Ensure malformed message shapes and timestamps cannot throw before or outside the forwarding fail-safe.
- [x] Ensure structured JSON can only override level with accepted `error`, `warn`, or `info`; invalid values keep the already-normalized console level.
- [x] Ensure structured `message` and `event` are only used when they are non-empty strings; otherwise fall back to raw joined message and `log`.
- [x] Ensure `subscriberCache` updates only when `response.ok` and the parsed subscriber count is finite and non-negative, while still consuming response bodies for all responses.
- [x] Tighten tail-worker unit fixtures enough to make adversarial payload cases explicit and readable.
- [x] Add regression tests for invalid timestamps, malformed message shapes, structured `level: "debug"`, non-string/empty structured `message` and `event`, and 500 JSON `{ "subscribers": 0 }` fail-open behavior.
- [x] Run `pnpm --filter @simple-agent-manager/tail-worker test`.
- [x] Run `pnpm --filter @simple-agent-manager/tail-worker typecheck`.

## Acceptance Criteria

- [x] Normal `error`, `warn`, `info`, and `log` entries preserve existing forwarding behavior.
- [x] Malformed timestamps and message shapes do not throw and still forward a string timestamp/message when the normalized console level is accepted.
- [x] Forwarded `TailWorkerEvent.entry.level` is always one of `error`, `warn`, or `info`.
- [x] Forwarded `TailWorkerEvent.entry.message` and `.event` are strings, with safe fallbacks for invalid structured JSON fields.
- [x] Non-2xx ingest responses, including JSON bodies with `subscribers: 0`, do not arm or refresh the zero-subscriber cache.
- [x] Focused tail-worker tests and typecheck pass.

## References

- `apps/tail-worker/src/index.ts`
- `apps/tail-worker/tests/unit/tail-handler.test.ts`
- `apps/tail-worker/tests/unit/subscriber-gate.test.ts`
- `apps/api/src/routes/observability-ingest.ts`
- `apps/api/src/durable-objects/admin-logs.ts`
- `tasks/archive/2026-05-04-fix-tail-worker-ingest-auth.md`
- `ab20fdbf fix(observability): gate tail forwarding on subscriber count + demote heartbeat logs (#1226)`
