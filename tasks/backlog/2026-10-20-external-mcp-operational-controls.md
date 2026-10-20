# External MCP operational controls

## Problem and authorization
External clients cannot interrupt safely or inspect delivery/runtime/cleanup/job/approval outcomes. Implement audited idea 01M5C4RT0SS8DZ5P44QWXS58C7. User authorizes PR, CI, review, merge, production deployment and smoke; explicitly skips staging deployment and staging tests. No estimates. Preserve Opus PR #2383 and runtime.

## Research
Shared registry in operations/registry.ts feeds connector-mcp.ts. Existing cancel API records turn end; durability snapshot exposes mailbox receipts. InteractionStore has pending/settled outcomes. D1 workspace deletion proof and execution snapshots exist. Reads must not wake resources. Runtime telemetry and job coverage are incomplete: expose unknown/unsupported rather than invent evidence. Use current writer checks, never expand project-reader/node access.

## Implementation checklist
- [ ] Extract reusable non-destructive interrupt with turn fencing and idempotency.
- [ ] Add bounded safe status, delivery lookup and diagnostic projections with canonical idleness and resource/cleanup proof.
- [ ] Add incremental state/change cursor without lossless event/push guarantees.
- [ ] Expose writer-scoped pending/settled interaction details and fix shared-session pending visibility; retain mandatory answer confirmation.
- [ ] Add typed persisted job results with explicit adapter coverage.
- [ ] Add actor-scoped uncertain requestKey operation lookup without replay.
- [ ] Add unit/integration authorization, redaction, fencing and read-side-effect tests.
- [ ] Document tool schemas, limitations and data flow; review security, Cloudflare, completion/docs/constitution.
- [ ] Exact-final-head CI green, CodeRabbit requested/waited, merge and production deploy/smoke.

## Acceptance
All scoped capabilities callable through actual complete external MCP registry. Reads do not call runtime mutation or expose raw errors/output/secrets. Permission answers still require explicit human confirmation and generation checks. IDs are typed by source; missing evidence remains unknown. No real session interruption or teardown tests. Staging explicitly skipped, never claimed passed. Production smoke read-only/minimal and deployment version reconciled.

## References
AGENTS.md; .agents/skills/do; API reference/security/cloudflare/completion specialist skills; audit idea linked above.
