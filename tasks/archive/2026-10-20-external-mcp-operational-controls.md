# External MCP operational controls

## Problem and authorization

External clients cannot interrupt safely or inspect delivery/runtime/cleanup/job/approval outcomes. Implement audited idea 01M5C4RT0SS8DZ5P44QWXS58C7. User authorizes PR, CI, review, merge, production deployment and smoke; explicitly skips staging deployment and staging tests. No estimates. Preserve Opus PR #2383 and runtime.

## Research

Shared registry in operations/registry.ts feeds connector-mcp.ts. Existing cancel API records turn end; durability snapshot exposes mailbox receipts. InteractionStore has pending/settled outcomes. D1 workspace deletion proof and execution snapshots exist. Reads must not wake resources. Runtime telemetry and job coverage are incomplete: expose unknown/unsupported rather than invent evidence. Use current writer checks, never expand project-reader/node access.

## Implementation checklist

- [x] Extract reusable non-destructive interrupt with turn fencing and idempotency.
- [x] Add bounded safe status, delivery lookup and diagnostic projections with canonical idleness and resource/cleanup proof.
- [x] Add incremental state/change cursor without lossless event/push guarantees.
- [x] Expose writer-scoped pending/settled interaction details and fix shared-session pending visibility; retain mandatory answer confirmation.
- [x] Add typed persisted job results with explicit adapter coverage.
- [x] Add actor-scoped uncertain requestKey operation lookup without replay.
- [x] Add unit/integration authorization, redaction, fencing and read-side-effect tests.
- [x] Document tool schemas, limitations and data flow; review security, Cloudflare, completion/docs/constitution.
- [ ] Exact-final-head CI green, CodeRabbit requested/waited, merge and production deploy/smoke.

## Acceptance

All scoped capabilities callable through actual complete external MCP registry. Reads do not call runtime mutation or expose raw errors/output/secrets. Permission answers still require explicit human confirmation and generation checks. IDs are typed by source; missing evidence remains unknown. No real session interruption or teardown tests. Staging explicitly skipped, never claimed passed. Production smoke read-only/minimal and deployment version reconciled.

## References

AGENTS.md; .agents/skills/do; API reference/security/cloudflare/completion specialist skills; audit idea linked above.

## Implemented boundaries

Seven actual registry tools: interrupt, status, delivery get, interaction snapshots, coalesced changes, typed job observations and own operation receipts. Safe Sleep/Resume deferred. Guarded cancellation adds a separate VM endpoint; older runtimes fail closed. Process stop is scoped to the matched attempt and blocks admission until termination proof; uncertain stops remain blocked. Raw operational state never synthesizes idle from persisted plans.

## Validation/release state

Full API suite: 12,818 passed, 2 skipped. Full VM-agent suite passed. Repository-wide lint/typecheck/build passed. Local Workers approval suite: 5 passed. Latest targeted Go race/auth and shared-transcript tests pass. Security, Cloudflare/constitution, completeness/docs and final Go review findings addressed. Staging intentionally skipped by user; no production permission grants or live interruption tests. Required final-head CI and normal production workflow remain pending. Task-file direct main push was rejected by branch protection; no retry, all publication through PR.

Final Go review correction: immutable attempt-owned cancellation completion policy yields recovering/ready/error publication to process monitor, preventing a late local completion from overwriting restarted runtime state. Deterministic state-preservation and race tests pass.
