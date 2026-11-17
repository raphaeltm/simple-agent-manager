# L19: guided-setup teardown robustness (self-host landing slice, Cloudflare part)

SAM task `01M7M9FHH6VPWVFTVB6P8X230P`; idea `01M72M9AEB933ZY8269D376DKC` (landing plan parts 2 and 6, change C14);
coordinator task `01M7JMXS2JRW6QQMB1356ENPM3`; channel `feature.selfhost-landing`.

## Problem

`CredentialSetupSession` teardown (`apps/api/src/durable-objects/credential-setup-session/index.ts`)
claims the terminal status in DO SQLite, then awaits the sandbox scrub, the destroy and the pool
release, and only then writes D1. An isolate that dies during that sandbox I/O leaves:

- the D1 row active, so the create route's one-active lookup keeps returning the dead session
  until the cron sweep finds it;
- the pool slot leased and the container alive, with no alarm to finish the cleanup (teardown
  deleted nothing yet, but nothing resumes it either).

A teardown that starts from `provisioning` (cancel during start, or the start itself failed) also
execs `rm -rf` into a container that never started. On Cloudflare that exec makes the SDK start
the container again and wait out its start retries before the destroy runs.

The integration branch `sam/selfhost-pass-2` fixed all three (commits 30c1b1840, f0743271f,
a5bce064e, acf865e32). This slice ports the part that matters on Cloudflare.

## Scope decision (Raphaël's 2026-11-14 rule: no dormant self-host code in the Worker)

| Branch change                                                                                              | Ported?          | Why                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teardown reorder: D1 terminal before sandbox I/O, `cleanup_pending` marker, recovery alarm, bounded resume | Yes              | Isolate death mid-teardown happens on Cloudflare too                                                                                               |
| Skip scrub when teardown starts from `provisioning`                                                        | Yes              | On Cloudflare the exec restarts a never-started container; destroy removes the filesystem anyway                                                   |
| Skip scrub on a resumed cleanup                                                                            | No (review M2)   | celld-only reasoning; on Cloudflare the container outlives the dead isolate, so a resume must still scrub the captured credential                  |
| Bound the scrub exec with `withTimeout`                                                                    | Yes              | The exec timeout does not cover the SDK's container start before it                                                                                |
| Alarm joins an inline cleanup instead of running a second one                                              | Yes (plain join) | The recovery alarm fires at `capture_poll_ms` (3 s), usually while the inline cleanup is running (rule 45)                                         |
| Alarm stops waiting after `2 x exec timeout + 30 s` (`settleSharedFlight`)                                 | No               | Only celld drops a request's sandbox calls; on Cloudflare every cleanup step is bounded                                                            |
| `sandbox_runtime_unavailable` for the SDK's permanent start error                                          | Yes              | The SDK itself answers 500 with that message for Cloudflare permanent failures (`no such image`, `no application that matches`, OOM)               |
| `SandboxDO` subclass, `sandbox-startup-errors.ts`, `ctx.container.monitor` tee and its 2 s / 20 ms poll    | No               | Every matched fragment is a Docker / celld / sam-docker-proxy string; on Cloudflare every answer passes through unchanged. Self-host build owns it |
| `platform-capabilities` gating in `sandbox.ts` / route                                                     | No               | Belongs to other slices (platform capabilities), not C14                                                                                           |

## Research findings

- `pnpm quality:do-migration-safety` does NOT scan `credential-setup-session` (excluded in
  `scripts/quality/check-do-migration-safety.ts` because its dynamic D1 `UPDATE ... SET ${...}`
  false-positives). So the branch's constructor `PRAGMA table_info` + guarded `ALTER TABLE ADD
COLUMN` would ship unscanned. Fix: move all DO-SQLite DDL into
  `credential-setup-session/schema.ts` and add that file to `DO_MIGRATION_FILES`.
- `index.ts` is 754 lines; the port adds ~200 → over the 800 hard limit (rule 18). Split: schema
  - row types into `schema.ts`, D1 status writer into `d1-status.ts`, sandbox/pool cleanup steps
    into `cleanup.ts`.
- New Env scalars fail `pnpm quality:runtime-tunables`. The initial port reused existing
  tunables: recovery alarm delay = `SETUP_SESSION_CAPTURE_POLL_MS` (per-session
  `capture_poll_ms`), scrub bound = `SANDBOX_EXEC_TIMEOUT_MS`. The recovery-attempt cap (3) is a
  crash-loop circuit breaker, exported as `DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS`.
- Rule 81: the monitor poll is not ported, so the per-start cost on Cloudflare is zero. Recovery
  cost: at most 3 extra alarm runs per failed/interrupted teardown, each one cached/bounded settings read, scrub + destroy (default5s each, max10s each), release + D1 repair, followed on exhaustion by one quarantine/observability write. No new per-start I/O.

## Implementation checklist

- [x] Split commit: `schema.ts` (DDL + row types), `d1-status.ts` (D1 status writer) with no behaviour change
- [x] Add `schema.ts` to `DO_MIGRATION_FILES`; scanner test asserts it is scanned and passes
- [x] Additive cleanup columns via PRAGMA + literal guarded `ALTER TABLE ADD COLUMN` in `schema.ts`
- [x] Teardown: claim + `cleanup_pending` + alarm + D1 terminal before any sandbox I/O
- [x] `cleanup.ts`: scrub (skipped only on initial `provisioning` cleanup; resumed cleanup scrubs unless destruction was durably confirmed; bounded), destroy, release, D1 repair (`onlyIfActive`), clear marker + alarm
- [x] Alarm: terminal row with `cleanup_pending = 1` resumes cleanup; joins inline flight; capped attempts
- [x] `withTimeout` exported from `services/sandbox.ts`
- [x] `sandbox_runtime_unavailable` for the SDK permanent start message (constant in `credential-setup-config.ts`)
- [x] Port `credential-setup-session-teardown.test.ts` (real SQLite DO + D1, real create route) minus celld-only cases; update fake SQL in existing tests
- [x] Prove guards discriminating (D1-first ordering, scrub skip, join, attempt cap)
- [x] Docs: check public docs for guided login error codes

## Acceptance criteria

- [x] A teardown interrupted after the claim leaves D1 terminal and the create route starts a fresh session (test)
- [x] A restarted instance finishes an interrupted cleanup on its alarm; the next alarm is a no-op (test)
- [x] An alarm during an inline cleanup does not run a second destroy/release (test)
- [x] Recovery gives up after the cap instead of re-arming forever (test)
- [x] Teardown from `provisioning` does no scrub exec; still destroys and releases (test)
- [x] The SDK permanent start message maps to `sandbox_runtime_unavailable`; other errors keep `sandbox_provision_failed` (test)
- [x] `quality:do-migration-safety` scans the constructor DDL
- [ ] Staging: Instant session gets an agent reply; Q1 guided Codex login shows verification URL/code, cancellation immediately terminalizes D1, clears DO cleanup and releases pool slot, and a new attempt starts; Q2 cancellation during provisioning shows terminal UI immediately and logs `credential_setup.scrub_skipped` (coordinator accepted 2026-11-17 12:25 UTC; SDK permanent-start mapping covered by contract test; no throwaway image deploy)

## Review-driven changes (Phase 5)

- cloudflare-specialist M1 / validator: the recovery alarm could start a second cleanup while
  teardown's claim-time D1 write was in flight (`cleanupInFlight` was set only after it).
  Fixed: `trackCleanup()` registers the whole post-claim run before the first await. Test:
  "an alarm that fires during the claim-time D1 write joins the teardown" (red on old ordering).
- cloudflare-specialist M2: resumed cleanup now scrubs (see scope table).
- test-engineer: claim guard, claim-time alarm, `device_auth_details` delete, `saving` early
  return, TTL expiry and legacy terminal rows now have discriminating tests; the join test no
  longer sleeps on the wall clock.
- test-engineer: the DO migration scanner missed a single-quoted `DROP TABLE` after an
  apostrophe in a comment (per-quote-style regexes paired delimiters globally). Replaced with a
  comment-aware tokenizer; it extracts 65 more real SQL lines in existing migration files, all
  still passing; regression test is red on the old extractor.

## Continuation review fixes (task 01M7NBJ5EH19V5SV26NFJFJ6GM)

- [x] Merge origin/main including safe-deploy #2841 (`0c672ddbf`); secret-readback guard passes.
- [x] Codex P1: resumed cleanup from provisioning must scrub because a driver-start exec can still be in flight when cancellation claims the status. Regression fails with the old predicate.
- [x] Codex P1: regex literals can contain comment-looking text; use the existing TypeScript parser for SQL extraction. Regression and real file scanner test prove a same-line DROP is detected.
- [x] Codex P2: failed destroy, pool release, or D1 repair retains cleanup owed; exhausted recovery retains that marker and persists an operator-visible error while stopping automatic retries. Pool leases independently expire at next admission (default TTL + buffer = 20 minutes); Sandbox SDK defaults stop idle containers after 10 minutes.
- [x] Verify failed inline cleanup re-arms after an alarm joined the in-flight attempt (controlled regression red before fix).
- [ ] Complete fresh delta specialist reviews, final local checks and current-head CI.
- [ ] Complete agreed live checks, clean fixtures and release staging lease.
- [ ] Observe coordinator's production #2841 merge-hold-lifted message before normal merge.

- [x] Later Codex P2: persist successful sandbox destruction before pool/D1 I/O; recovery skips scrub and destroy once proven, so it cannot recreate a destroyed container. Nullable additive `cleanup_sandbox_destroyed` column is migration-scanned; interrupted-release regression was red before fix. Legacy NULL retains conservative scrub/destroy behavior.

- [x] Late Codex P2: alarm arming is best-effort at initial teardown, resumed cleanup and failed-cleanup rearm. A scheduling rejection never prevents inline D1/resource cleanup; three boundary regressions failed before fix and now pass (teardown suite27/27).

- [x] Sixth Codex P2: dedicated admin setting `credentialSetup.cleanupRecoveryStepTimeoutMs` (default5s, max10s per sandbox step) for recovery scrub/destroy, including SDK acquisition. Inline retains30s. Recovery alone adds cached settings read, max3attempts. Timer regression proves old30s behavior fails at5s; late acquisition must not start a fresh exec after timeout/destruction.

Final continuation local evidence: full API run completed1093passingfiles/16715passingtests; its12failures were3intentional pre-fix alarm regressions plus9old fake-SQL destruction-marker misclassifications, all subsequently green in teardown/nativefocusedruns. Native route suite12/12passes. Final timeout/config/teardown suites62/62pass with two discriminating red proofs. Root lint22/typecheck36/build18passed; final APItypecheck/scopedlint/runtime-tunablespass. Two unrelated webfiles39/39pass isolated after broad-loadtimeouts; infra75/75pass isolated. CI and live staging remain binding.

## Final SDK-flight and mirror follow-ups

- [x] Durable nullable `cleanup_scrub_state` records not-issued/uncertain/observed-settled scrub work. A deadline cannot prove SDK cancellation; pending work prevents destruction proof, slot release and clearing the cleanup obligation. Original settlement is registered with `waitUntil`; eviction remains uncertain and reaches the existing bounded quarantine. Late settlement never resets the attempt cap.
- [x] A durable SDK-flight counter covers provisioning, device-state polling, verification-code writes, credential reads and scrub. Each original chain owns one increment/decrement; overlapping calls cannot clear each other's obligation. Every SDK await is followed by an authoritative status check before further SDK work. Fresh sessions initialize the counter to zero; legacy NULL remains conservative.
- [x] All active D1 transitions are active-only writes. A delayed admitting write cannot resurrect a row after cancellation, even before recovery repair.
- [x] Recovery D1 repair and pool release use the same short configurable deadline as scrub and destroy. Four remote waits total at most 20 seconds by default/40 seconds maximum per attempt, plus the existing bounded settings read. The quarantine alert is background work after its durable disposition.
- [x] Final focused suites: teardown40/native12/existing30/admin3 =85/85; scanner15/15; API TypeScript/scopedESLint/migration safety/runtime-tunable/secret-readback checks pass. Surgical D1 guard, overlap counter and settlement-cap mutations each reproduced the intended regression before restoration. Tests also cover all four provisioning await phases, legacy rows, late scrub settlement, eviction and actual recovery timers.
- [x] Independent Cloudflare/security/constitution and test/completion/public-doc reviews PASS for this implementation delta. Final current-head CI remains required.
- [ ] Agreed live staging checks, fixture cleanup, lease release and coordinator merge-hold release remain pending; no staging resources have been created by this continuation.
