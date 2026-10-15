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

## Validation — final local

- Full serialized API suite PASS880files/12402tests;1file/2existing skips unchanged,1550.82s. Initial334oldfixture failures resolved explicitly; affected8files363PASS, no production fallback or timeout/skip changes.
- Complete integrated VM-agent Go test/vet/build PASS; initial config/server/bootstrap also passed.
- Final real Worker16tests PASS: actual authenticated held-body env-unset bridge, delayed KV put/activated clear, preactivation clear/later append/stale visibility/restart, immutable mutations/both renames/duplicate variants/supported replay.
- Full scripts suite PASS52files729tests, including realv21→v22 and clean-install class assertions. TTS94PASS after final shared lazy initializer; file797wc/checker798 under unchanged800 limit.
- APItypecheck/full lint/scoped final lint PASS. Local Workerbundle dry-run PASS with container rollout disabled only for this build check; Container declarations and nested Docker remain intact.
- CI-pinned current-tree Gitleaks50reviewed0new and exact-ref PR-range0/0 PASS; baseline/coverage unchanged. Format2150/2225,sourcecontract1677,migration/order/DO/bindings/runtime-state/file-size/diff checks PASS. PR2361 preflight/specialist validators PASS.

CI fixes are narrow commits: `6f6dcf1da` shares lazy speech agent initialization; `7a623c627` updates v22 expectations and adds unchanged-v21-prefix/exact-new-class tests. Independent `INTEGRATION-API-STARTUP-20261015-04` PASS. Original source A/B CI/Sonar green per coordinator; integration final exact-head CI/Sonar/security/CodeRabbit remain coordinator-owned.

## Release and staging constraints

Initial prebridge invocations/deferred KV work cannot be fenced retroactively. Activation is BLOCKED until coordinator establishes a concrete retirement/cancellation boundary; neither 100% traffic nor a timer proves it. Never publish the activation record before that proof. Source/runtime bridge validation may be staged only by coordinator after current staging owner releases. The global immutable shared-staging activation record must remain ABSENT; a smoke project is not isolation. Activation tests require fresh isolated Worker/DATABASE/KV/DO stores or remain covered by real Worker tests. Never reset guards or delete the shared record to clean up a test. Coordinator owns final pinned manifest, exact-head CI/Sonar/security/CodeRabbit, production rollout and runtime proof.

Consolidated configured-pool sweep: verify migrations/bindings on clean/existing installs, bridge-unset KV behavior, shared activation on isolated test records, concurrent MCP exact admissions/headers/fallback identities, held-body and delayed log ordering, compatible rollback/restart, real boot callbacks/heartbeat, Git helper actual30s plus clone/push/gh slow/transient/exhaustion/cancel/revocation, and cleanup. No independent staging or production action.

## Bootstrap evaluation — no implementation

Fresh read-only adversary `BOOTSTRAP-ADV-01` assessed immutable birth ownership, grandfathered KV identities and credential fences. `BOOTSTRAP-ADV-02` found a concrete old-issuer counterexample: prebridge `node-lifecycle.ts` ready handler authenticates a node JWT, awaits the JSON body, then queries current pending workspaces. A held old request can discover a newly DO-owned workspace and mint/deliver a v1 callback JWT. Birth-owner columns and new-validator credential versions alone do not fence that old signer. Go workspace callback verification also requires the current audience, so a new protocol needs an explicit compatibility audit/design review. No birth-registry/credential-version architecture was implemented or approved. Shared activation remains blocked; full C objective is unresolved, not waived.

## Independent A/B release option

Clean `release/reliability-ab-2026-10-15` head `4b33a6585935bd5753c31892507d9b66e3ca72db` contains A+B and only reviewed startup TTS plus final lazy initializer. It contains no C code/migrations/activation. Independent `AB-COMPOSITION-COMPLETION-20261015-05` PASS; ABaffected5files151tests/typecheck/bundle/state/current50-0/range0-0 PASS. Entire Go tree matches the fully tested integration bytes. Coordinator chooses release sequencing; full C draft remains preserved.
