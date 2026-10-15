# Reliability A/B/C clean integration — 2026-10-15

Coordinator task `01M50044HCHRVR12B4337721G5` assigned integration and C cutover correction to existing Sol B task. No additional implementation owner, deployment, or merge authority.

## Source manifest

- A: `3d45a2d1c981cc10be572b5b1d19ca9769a17edf`, clean PR2355.
- B: `f71e79b81b3b3f9d01f765d66db3be26c808212d`, clean draft PR2358.
- C intended: `a890a46b367227a61c358d1863addbaff129d42d`, original draft PR2357; no later platform autosaves included.
- Upload startup fix: only `apps/api/src/services/tts.ts` from reviewed `c3e0bb75ad7337986618537c473aa6f1e65c2369`, narrow commit `3a8f07288`.
- Shared-activation correction checkpoint `b945a7ebd`; immutable-record guards checkpoint `82c08c9eb`. Clean integration branch `release/reliability-2026-10-15-integrated`; live root checkout remains original B branch to quarantine autosaves.

## Correction

Old env-unset bridge requests could hold an HTTP body across a version-local cutover and then admit against KV while configured versions used SQLite. Shared primary D1 activation replaces per-version timestamps. MCP pins its rate window before lookup; all bridge log operations are serialized through the workspace DO including complete legacy KV operations. Preactivation clear/replacement persists a suppression fence and ordered subsequent append view, preventing stale KV resurrection across activation/restart. Migration0196 rejects activation update/key rename/delete/conflicting insert/replacement. Generic application settings writers accept fixed integration/setup keys, not arbitrary activation keys. Production activation requires insert-once future SQL publication documented in the runbook.

## Independent local reviews

- Architecture `RC-CUTOVER-ARCH-20261015-01`: proposed invariants PASS.
- Fresh adversarial security `security-review-reliability-c-cutover-2026-10-15-02`: ADDRESSED preactivation-clear MEDIUM, corrected bridge PASS.
- Guard/config adversarial `security-review-reliability-c-immutability-2026-10-15-02`: PASS, including both key rename directions and normal test-config composition.
- Cloudflare/constitution `REL-C-CF-CONSTITUTION-20261015-02`: PASS, primary sessions/DO ordering/guards/config/docs.
- Completion/docs `RC-COMPLETION-CUTOVER-20261015-02`: PASS implementation; external activation blocker preserved.

## Validation

Integrated Go config/server/bootstrap PASS. Initial affected API5files139tests PASS. Boundary API3files42tests PASS; deployment generation60tests PASS. Real Worker16tests PASS before final key-rename assertions; final rerun in progress. API typecheck PASS. Scoped lint PASS; complete API lint/full suite in progress. Broad suite exposed old unit fixtures without primary-session support and three real SQLite fixtures missing platform_settings; explicit boundary fixtures/schema corrected, no production fallback or gate waiver. Full current-tree scanner PASS50reviewed0new with unchanged baseline/coverage; C test bindings grouped in a normal composition helper. Migration safety/order, DO migration safety, Wrangler bindings PASS. No runtime state files in integration tree.

## Release and staging constraints

Initial prebridge invocations/deferred KV work cannot be fenced retroactively. Activation is BLOCKED until coordinator establishes a concrete retirement/cancellation boundary; neither 100% traffic nor a timer proves it. Never publish the activation record before that proof. Source/runtime bridge validation may be staged only by coordinator after current staging owner releases. Coordinator owns final pinned manifest, exact-head CI/Sonar/security/CodeRabbit, production rollout and runtime proof.

Consolidated configured-pool sweep: verify migrations/bindings on clean/existing installs, bridge-unset KV behavior, shared activation on isolated test records, concurrent MCP exact admissions/headers/fallback identities, held-body and delayed log ordering, compatible rollback/restart, real boot callbacks/heartbeat, Git helper actual30s plus clone/push/gh slow/transient/exhaustion/cancel/revocation, and cleanup. No independent staging or production action.

## Final affected validation and bootstrap assessment

All corrected old API fixtures PASS8files363tests. Final real Worker suite PASS16tests including both rename directions, OR IGNORE/conflicting/identical insertion rejection and supported no-op publication replay. Current-tree scan PASS50reviewed0new, exact integration PR-range PASS0/0; no baseline/scanner changes. API typecheck and full lint pass; local Wrangler Worker bundle dry-run passes with container rollout disabled for the build-only check (nested Container declarations preserved). PR2361 preflight and specialist-evidence validators pass. Independent final fixture audit `RC-FINAL-COMPLETION-20261015-03` PASS at6f863a627. Final full API serialized rerun is still active; initial broad fixture failures are historical, not waived.

Coordinator requested evaluation, not implementation, of per-identity bootstrap. Fresh Sol read-only adversary `BOOTSTRAP-ADV-01` finds it conditionally viable: authenticated MCP token snapshot exclusively selects task/session/workspace fallback key; boot callbacks reject node scope and require exact workspace match. Birth ownership before first usable credential, a verified barrier against new prebridge invocations, default-KV old producers, immutable grandfathering across token renewal/session restoration, and an exhaustive creation-path audit are required. Creation/token timestamps alone are insufficient. No such architecture change implemented or approved; shared activation remains blocked pending coordinator's concrete proof/decision.
