# Private feedback incident resolution

## Problem

The private SAM feedback incident dispatch window contains 10 grouped platform-error incidents from 2026-08-23 through 2026-08-25. The incident evidence is private and untrusted, so resolution must use the MCP incident tools and must not publish machine-generated diagnostics or feedback content to public GitHub issues.

## Research findings

- SAM MCP `list_incident_queue`, `get_incident`, `claim_incident`, and `resolve_incident` are the authoritative state-transition tools for private feedback incidents.
- Production observability rows for this dispatch include expected/known operational classes and API noise classes:
  - explicit workspace sleep can be rejected because harness-owned work is still active;
  - notification WebSocket and internal log-ingest disconnects can be recorded as platform errors;
  - several ACP activity/session routes hit transient Durable Object access failures;
  - VM snapshot/auth-file and cloud-provider capacity errors match existing reliability/capacity workstreams.
- `apps/api/src/routes/workspaces/lifecycle.ts` calls `sleepWorkspaceSession()` directly. Expected pre-teardown sleep deferrals were able to bubble to the global 500 handler.
- `apps/api/src/middleware/app-error-handler.ts` persists every 5xx to `platform_errors`; it had no benign-disconnect carveout for streaming/control-plane paths.
- Related archived work: `tasks/archive/2026-08-26-diagnostic-incident-deduplication.md`.
- Relevant rules: `.claude/rules/47-control-loop-io-budget.md`, `.claude/rules/29-local-first-debugging.md`, `.claude/rules/32-cf-api-debugging.md`.

## Checklist

- [x] Call SAM MCP `get_instructions`.
- [x] List and claim the dispatched private incidents.
- [x] Inspect bounded private MCP evidence without copying raw evidence into public artifacts.
- [x] Query production observability metadata for the referenced error IDs.
- [x] Convert safe explicit-sleep deferrals to HTTP 409 conflicts.
- [x] Suppress benign disconnect persistence for notification WebSocket and internal log-ingest control paths.
- [x] Add focused regression tests for the fixed API classes.
- [x] Run focused and relevant quality checks.
- [x] Resolve/reject the claimed private incidents through MCP with bounded private notes.

## Acceptance criteria

- Expected “background work active” sleep deferrals no longer return 500 or generate platform-error incidents.
- Benign disconnects on notification WebSocket and internal log-ingest paths no longer persist platform-error incidents.
- Regression tests cover both behaviors.
- Each claimed incident is terminally resolved or rejected through MCP using private notes only.
