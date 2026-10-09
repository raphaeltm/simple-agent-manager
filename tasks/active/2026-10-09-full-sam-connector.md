# Full SAM Connector

Authoritative design: SAM idea `01M4GJ0W0DS5BTKBM1YW0X5YC8`, project `01KHRJGANBBWGDY1NZ0KVF0D4J`. Implementation child `01M4H0TFBRMW2S5XATMPNZYDXN`. Preserve the idea.

## Constraints and research

User explicitly prohibits merge and deployment. Keep all work on `sam/run-repository-skill-implement-nzydxn`; do not push task bookkeeping to main because it triggers deployment. P0 is owned by task `01M4GVCTT82B9BMJM46GMXH0YX`, PR #2293, and its branch is reused, not reimplemented. Profile/runtime metadata confirms MF'in Astra / gpt-6-astra.

Existing operations are in `apps/api/src/operations`. PAT HMAC authentication is in `routes/api-tokens.ts`; user denial gates in `services/signup-approval.ts`. Existing `cli_operation_receipts` provide permanent intent reservations. Task submission, chat prompting, permissions, stop and project reads must be extracted rather than accessed by loopback HTTP. OAuth must use the approved maintained provider; no handwritten authorization server.

## Implementation and acceptance

- [ ] Reuse P0 foundation and incorporate final P0 fixes.
- [x] All 18 catalog operations, membership/capability/session ownership checks inside operations, shared dispatch preserving VM/Instant/quotas/profile/skill selection.
- [x] Official SDK stateless endpoint, legacy and modern protocol support, stable schemas/annotations, structured output/deep links/untrusted text.
- [x] PAT and OAuth bearer authentication, current user status gates, audience binding, scope challenges.
- [x] Atomic read/write/start budgets, write audit with safe summaries, idempotency via existing receipts, provenance.
- [x] OAuth discovery/DCR/PKCE/consent/token refresh rotation/revocation and configurable settings; OAUTH_KV provisioning.
- [x] Mobile/desktop consent, Settings Access and Connected apps, Admin Integrations Connector controls, provenance labels.
- [x] Public guide, self-hosting/env/API references.
- [ ] SQLite attack/control tests and guard mutation checks; real MCP client tests; OAuth conformance and full capability flow.
- [ ] Lint/typecheck/tests/build, mobile/desktop Playwright screenshots reviewed.
- [ ] Independent specialist reviews, all findings addressed.
- [ ] PR required checks green, CodeRabbit requested and any feedback resolved, ready for review.

Scope follows the fully specified and approved P0–P2 Connector. The specification author confirmed P3 toolsets and P4 /sam belong to later roadmaps. Do not claim them implemented without specification and implementation evidence. Staging deployment is prohibited by the current request; document exactly which verification remains unperformed.
