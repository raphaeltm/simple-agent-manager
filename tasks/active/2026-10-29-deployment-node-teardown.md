# Repair deployment teardown and recover stuck records

SAM task 01M639TC6GWAH5T9GRW3F96CQN; parent 01M6364S1M4WHNR1JJZ062B82Y.
User authorizes green non-draft PR, merge and production deployment. Explicit staging waiver; basic production smoke only.

## Research

- Production confirmed three destroying deployment nodes and healthy legacy deployment unchanged.
- Exact IDs/providerless failures documented in `tasks/archive/2026-10-22-deployment-env-error-recovery.md`; authority cause already fixed in #2409. Existing real SQL tests cover recovery.
- Stop currently unlinks/stops before provider cleanup, hides failures as warnings, and cannot retry. Workspace sweeps intentionally exclude deployments.
- Providerless deployment nodes carry complete exact placements but strict inventory proof accepts only workspace role.
- Legacy account attribution alone cannot prove original credential selection; absent legacy resources require historical binding/deletion evidence. Positive provider ownership can recover a live legacy binding without disrupting applications.

## Implementation and acceptance

- [x] Keep failed stop placement linked and visibly failed; retry converges with strict proof.
- [x] Dedicated bounded/backoff deployment cleanup backstop; protect healthy/shared/user-owned/foreign nodes and workspace artifacts.
- [x] Exact deployment providerless inventory reconciliation retains every ownership/incarnation/account fence.
- [x] Positive live legacy binding recovery; never treat wrong-account 404 as proof.
- [x] Extend orphan inventory coverage to user/project credentials, preserving live claims and bounded global destruction.
- [x] Real SQL regression tests for failure/retry/interruption/external absence/providerless/legacy/protection; preserve deployment volumes/releases/config.
- [ ] Specialist reviews, complete relevant quality checks, green PR, best-effort CodeRabbit.
- [ ] Merge, successful production deployment/basic smoke, safely recover existing state and report residual blockers to parent/channel.

## Workflow adaptation

SAM supplied an existing dedicated output branch/workspace; use it directly rather than creating a redundant worktree. Task artifact stays with this scoped PR to avoid unreviewed main changes during concurrent reliability work.

## Review and verification evidence

- Authority research: original failure fixed by #2409; no speculative provisioning change.
- Security audit: PASS independent re-review; positive-only account recovery, exact incarnation and preservation guards.
- Cloudflare: ADDRESSED stale stop interruption, atomic retirement and KV cursor write frequency; final re-review PASS.
- Test-engineer: 39 legacy real-SQL and 11 account-inventory regressions passed; actual lifecycle suite22 tests passed, including real provider404 and same-volume stop/start.
- Completion/constitution/doc-sync: implementation PASS; final repository quality and release gates remain below.
- Repository lint and typecheck PASS. Repository test/build in progress with bounded concurrency.
- Fresh providerless allocations on both environment cleanup and direct node Stop remain quarantined through the existing provisioning recovery window; no in-flight create can be mistaken for empty inventory. Final security re-review PASS.
- No staging per explicit user waiver. No production resources or records manually mutated.
- Residual: missing historical original-account proof can keep manually deleted legacy node150100869 quarantined; current unique credentials or a guessed-account404 cannot create proof.
