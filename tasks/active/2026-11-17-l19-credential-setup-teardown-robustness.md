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

| Branch change | Ported? | Why |
| --- | --- | --- |
| Teardown reorder: D1 terminal before sandbox I/O, `cleanup_pending` marker, recovery alarm, bounded resume | Yes | Isolate death mid-teardown happens on Cloudflare too |
| Skip scrub when teardown starts from `provisioning`, or on a resumed cleanup | Yes | On Cloudflare the exec restarts a never-started container; destroy removes the filesystem anyway |
| Bound the scrub exec with `withTimeout` | Yes | The exec timeout does not cover the SDK's container start before it |
| Alarm joins an inline cleanup instead of running a second one | Yes (plain join) | The recovery alarm fires at `capture_poll_ms` (3 s), usually while the inline cleanup is running (rule 45) |
| Alarm stops waiting after `2 x exec timeout + 30 s` (`settleSharedFlight`) | No | Only celld drops a request's sandbox calls; on Cloudflare every cleanup step is bounded |
| `sandbox_runtime_unavailable` for the SDK's permanent start error | Yes | The SDK itself answers 500 with that message for Cloudflare permanent failures (`no such image`, `no application that matches`, OOM) |
| `SandboxDO` subclass, `sandbox-startup-errors.ts`, `ctx.container.monitor` tee and its 2 s / 20 ms poll | No | Every matched fragment is a Docker / celld / sam-docker-proxy string; on Cloudflare every answer passes through unchanged. Self-host build owns it |
| `platform-capabilities` gating in `sandbox.ts` / route | No | Belongs to other slices (platform capabilities), not C14 |

## Research findings

- `pnpm quality:do-migration-safety` does NOT scan `credential-setup-session` (excluded in
  `scripts/quality/check-do-migration-safety.ts` because its dynamic D1 `UPDATE ... SET ${...}`
  false-positives). So the branch's constructor `PRAGMA table_info` + guarded `ALTER TABLE ADD
  COLUMN` would ship unscanned. Fix: move all DO-SQLite DDL into
  `credential-setup-session/schema.ts` and add that file to `DO_MIGRATION_FILES`.
- `index.ts` is 754 lines; the port adds ~200 → over the 800 hard limit (rule 18). Split: schema
  + row types into `schema.ts`, D1 status writer into `d1-status.ts`, sandbox/pool cleanup steps
  into `cleanup.ts`.
- New Env scalars fail `pnpm quality:runtime-tunables`. Timings in the port reuse existing
  tunables: recovery alarm delay = `SETUP_SESSION_CAPTURE_POLL_MS` (per-session
  `capture_poll_ms`), scrub bound = `SANDBOX_EXEC_TIMEOUT_MS`. The recovery-attempt cap (3) is a
  crash-loop circuit breaker, exported as `DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS`.
- Rule 81: the monitor poll is not ported, so the per-start cost on Cloudflare is zero. Recovery
  cost: at most 3 extra alarm runs per crashed teardown, each one destroy + one release + one D1
  write.

## Implementation checklist

- [ ] Split commit: `schema.ts` (DDL + row types), `d1-status.ts` (D1 status writer) with no behaviour change
- [ ] Add `schema.ts` to `DO_MIGRATION_FILES`; scanner test asserts it is scanned and passes
- [ ] Additive cleanup columns via PRAGMA + literal guarded `ALTER TABLE ADD COLUMN` in `schema.ts`
- [ ] Teardown: claim + `cleanup_pending` + alarm + D1 terminal before any sandbox I/O
- [ ] `cleanup.ts`: scrub (skipped from `provisioning` / resumed, bounded), destroy, release, D1 repair (`onlyIfActive`), clear marker + alarm
- [ ] Alarm: terminal row with `cleanup_pending = 1` resumes cleanup; joins inline flight; capped attempts
- [ ] `withTimeout` exported from `services/sandbox.ts`
- [ ] `sandbox_runtime_unavailable` for the SDK permanent start message (constant in `credential-setup-config.ts`)
- [ ] Port `credential-setup-session-teardown.test.ts` (real SQLite DO + D1, real create route) minus celld-only cases; update fake SQL in existing tests
- [ ] Prove guards discriminating (D1-first ordering, scrub skip, join, attempt cap)
- [ ] Docs: check public docs for guided login error codes

## Acceptance criteria

- [ ] A teardown interrupted after the claim leaves D1 terminal and the create route starts a fresh session (test)
- [ ] A restarted instance finishes an interrupted cleanup on its alarm; the next alarm is a no-op (test)
- [ ] An alarm during an inline cleanup does not run a second destroy/release (test)
- [ ] Recovery gives up after the cap instead of re-arming forever (test)
- [ ] Teardown from `provisioning` does no scrub exec; still destroys and releases (test)
- [ ] The SDK permanent start message maps to `sandbox_runtime_unavailable`; other errors keep `sandbox_provision_failed` (test)
- [ ] `quality:do-migration-safety` scans the constructor DDL
- [ ] Staging: Instant session gets an agent reply; guided credential login completes on Cloudflare containers; a forced container start failure shows the right error, not a hang
