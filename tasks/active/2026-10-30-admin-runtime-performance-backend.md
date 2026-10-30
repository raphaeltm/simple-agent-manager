# Admin and Runtime performance — backend PR

Part 1 of at most two sequential PRs for task 01M66P8F6P67ATNM175YHC2ZAY. The overall task remains active in `2026-10-30-admin-runtime-performance.md`; client cancellation, unused shell installation query removal, caching, UI tests and screenshots belong to the following frontend PR.

## Research and preflight

Classes: cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change.
Production log confirms the canceled request was GET /api/admin/agent-email on 2026-10-30 at 13:11:17.832Z, wall 113843ms, CPU7ms. Original evidence retained in session a9a9718e-d712-4405-bb42-f2164ab6f850, tool message ba3aeae2-0429-401a-90ac-b79c2280c8ab. Its handler has no external HTTP; include auth in GET deadlines.
Reconcile traces through source publication then up to200 sequential candidate writes, with a second select on no-op rows: potentially200–400 D1 round trips. Preserve source-generation claims before catalog reads and primary/coupled ordering in atomic candidate batches.
Auth enters four middleware layers on project subroutes but memoizes one session and one approval read. Start the fresh approval read alongside session lookup and consume only in requireApproved; preserve immediate401/suspended403. Resolve OAuth plaintext once per cached credential row and encryption key, with existing invalidation lifetime.
Admin settings uses one atomic primary batch; KV reads start concurrently and failures matter only if consumed. Mutations retain revision fences. Quota billing remains one charge per node lifetime and preserves canonical CPU fallback behavior.
No tracing config changes; no infrastructure or dependencies added. Tooling-only local Go/Chromium installed for required verification.

## Implementation

- [x] Streaming fetch/body deadlines, caller cancellation and JSON timeout propagation.
- [x] Configurable email overall/read deadlines; parallel reads/SPF includes; partial verification state; GET status/setup deadlines include auth.
- [x] Bounded GitHub discovery, identity/installations reuse, unchanged-upsert predicate, batched canonical writes and parallel independent organization verification.
- [x] Provider catalog deadline through ProviderRequestContext; independent source pipelines retain generation fencing; atomic ordered candidate writes and batched no-op verification; existing catalog cache reused.
- [x] Bound gateway, Analytics Engine and Cloudflare log reads.
- [x] Atomic admin settings snapshot, own-key connector/trials resolution, off-path expired-client cleanup, OAuth decrypted-value reuse.
- [x] Fresh auth approval overlap with unchanged denial gates.
- [x] Parallel project detail; no recent DO reads unless include=recent; bounded best-effort recent data; CLI opts in.
- [x] Parallel platform status, defaults/placement summaries, AI proxy config, errors/count, diagnoses/runs and diagnosis/incident, costs sources, runtime existence/count checks.
- [x] Safe runtime and admin credential projections.
- [x] Period-filtered usage, grouped canonical node CPU accounting, shared default quota and100-bind-safe user lookups.
- [x] SQL error trend buckets.
- [x] Split touched oversized services/routes into focused modules preserving public imports.

## Validation and acceptance

- [x] Stalled body RED/GREEN and caller-abort tests.
- [x] Email overall/hung-body/fast-path tests; stalled auth status/setup tests.
- [x] GitHub hung route504 and one identity/installations fetch each on fast path.
- [x] Real SQLite admin snapshot parity and post-batch concurrent writer consistency.
- [x] Real SQLite105-user quota/usage tests enforce100-bind ceiling; grouped CPU parity and historical-period exclusion.
- [x] Project noDO/CLIrecent/deadline controls.
- [x] CLI race/coverage run; package82.4%, total82.2%.
- [x] Final candidate batch-count and race regressions green.
- [x] Full suite21tasks on1f7; rebased quality35tasks and24review regressions green on031e9f2d4 + reviewed fixes.
- [x] Specialist code/test/doc reviews pass after two regression-backed fixes; completion release gates remain pending.
- [ ] Staging deployed on pinned backend head after shared-use coordination.
- [ ] Authenticated Playwright verifies relevant pages/actions; zero console errors.
- [ ] Measured staging before/after timing and server round-trip tables in PR.
- [ ] CI and best-effort CodeRabbit gates; merge and production basic smoke.

## Current verification limitation

Provided SAM_PLAYWRIGHT_PRIMARY_USER exists but staging token-login returns401 UNAUTHORIZED Invalid token format; current value has neither supported PAT prefix. Asked user where current staging browser credentials are stored; local work continues. Tracing task occupies staging deploys41078819673/41082816507; do not overwrite active verification.

## References

Overall task, rules03/18/39/48/59/60/62; .claude/skills/api-reference/SKILL.md documents include=recent. No edits to scripts/deploy/sync-wrangler-config.ts.
