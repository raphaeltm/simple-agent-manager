# Egress fence: no `ok` attestation after `lost` (self-host only)

Task 01M821FBS1H10YA0JYDVRWD9EX. Idea 01M8218V5V8631K33YMQVYGNQ1. Hosted SAM is unaffected.

## Problem

`deploy/selfhost/egress-fence/fence.sh` has two writers of the attestation: the kernel-event
reader subprocess (`lost()`) and the main loop (`ok <ts>` via tmp + `mv`). The main loop checked
`$LOST`, then published. A latch between the check and the `mv` left `ok` in the attestation
after `lost` until the next pass (10-100 ms). `scripts/selfhost/fence-watchdog.test.ts` failed on
main CI run 45041955760 (job 137268241147) in 104 ms: its poll saw the stub's injected `lost`,
exited, then read the `ok` the admitted `mv` published. So the failure was that window, not a
worse path, and the test was not ordering-deterministic.

## Research findings

- Consumers of the attestation:
  - `deploy/selfhost/celld/start.sh` `fence_problem()`: checked `lost` BEFORE reading the
    attestation, then probes, then the read. Runs every 0.1 s while celld serves.
  - `scripts/selfhost/verify-fence.ts` `checkService()`: ran `fence.sh check` (latch-aware)
    before `cat` of the attestation.
  - Compose healthcheck: `fence.sh check` (reads `$LOST` + fingerprint, not the attestation).
- No path found where `$LOST` is never written after a ruleset change: monitor events latch,
  monitor/reader death latches via `kill -0`, fingerprint drift latches via `check()`. A dead
  main loop stops refreshing `ok`, so celld stops at the 2 s max age.
- Blast radius of one stale `ok` read: celld's next 0.1 s pass sees `lost`; the probes run
  independently. At most one check interval of extra serving, during which the kernel table is
  already changed. verify-fence could report "in effect" once.

## Checklist

- [x] fence.sh: `lost()` and `publish()` share a flock on the fence's private tmpfs; publish
      skips when `$LOST` exists; latch still happens if the lock fails (fail closed)
- [x] Removed the "converge stale ok" branch (dead with the lock)
- [x] start.sh: check `lost` after reading the attestation
- [x] verify-fence.ts: read attestation before `check`; age measured at read time
- [x] Deterministic fence-watchdog test (real reader, real monitor event released mid-publish,
      stub flock marks lock attempts) + healthy control; red on old fence.sh and with either guard
      removed
- [x] verify-fence CLI test: latch right after the read is refused; red on old order
- [x] Live netns test: FIFO attestation owns the ordering; red on old start.sh
- [x] README section updated
- [x] 200x stress run under CPU load (result posted on PR #2978)
- [x] security-auditor (PASS, MEDIUM fixed: failed publish now latches), go-specialist (PASS, LOW comment fixed), task-completion-validator (PASS)
- [x] Live fence-netns suite 68/68 locally in the privileged lab; Self-host Live CI job on PR

## Acceptance criteria

- No `ok` is ever written while `$LOST` exists (fence-watchdog test).
- Consumers refuse an `ok` read before a latch that existed by the time they checked.
- Healthy fence keeps publishing fresh `ok`.
