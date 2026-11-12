# Guided credential setup: teardown leaves D1 active and waits on a dead container

## Problem

Found while prototyping guided login on celld (task 01M769WDVM4HCQ7185R8E2QGV6, notes on idea 01M75V57RG8GR4NA0KC91TM1J7, 2026-11-11). Applies to every runtime.

1. `CredentialSetupSession.teardown` (`apps/api/src/durable-objects/credential-setup-session/index.ts`) claims the terminal status in DO SQLite first. It then awaits the sandbox scrub `exec` and `destroySandboxInstance`, and only after those writes D1. If the isolate or process dies in between, the DO is terminal but D1 stays active. `POST /api/agent-credential-setup-sessions` keeps returning the dead session for that user and agent (the `existingActive` lookup) until `runSetupSessionSweep` reclaims the row after `expires_at`. That was about 19 minutes on the prototype box, which blocked retries.
2. When the container never started (runtime missing, image missing), the scrub `exec` restarts the container. Teardown then waits through the Sandbox SDK's ~150 s start-retry window before it destroys the container.
3. A start failure such as `unknown or invalid runtime name`, `No such image` or `RuntimeFailed` reaches the user only after the SDK's ~150 s retries. The prototype showed "Preparing secure sign-in…" for 137 s.

## Acceptance Criteria

- [x] D1 is marked terminal before any sandbox I/O in teardown, or create treats a DO-terminal row as inactive.
- [x] A restarted alarm completes an interrupted cleanup (scrub, destroy, pool release).
- [x] The scrub is skipped when provisioning never reached a running container, and scrub and destroy have short env-configurable timeouts.
- [x] Permanent container start errors fail the session promptly with a distinguishable error code (`sandbox_runtime_unavailable`; 1.5 s on the box with runsc unregistered, was 137 s).
- [x] Tests: interrupted teardown (the process dies after the DO claim) followed by a new create for the same user and agent, and a never-started container being torn down without a 150 s wait.

## Implementation Notes (teardown ordering, 2026-11-12)

- `teardown()` claims the terminal status, sets `cleanup_pending = 1` and `cleanup_from_status` (the pre-claim status) in the same synchronous step, arms a recovery alarm (`capture_poll_ms`), then writes D1 terminal before any sandbox I/O. `runCleanup()` does scrub, destroy, pool release, and a D1 repair write that only touches a still-active row, then clears the marker and the alarm.
- `alarm()` on a terminal row with `cleanup_pending = 1` resumes the cleanup (`resumeCleanup()`). An alarm that fires while the same isolate's inline cleanup is running joins it. After `MAX_CLEANUP_RECOVERY_ATTEMPTS` (3) interrupted recoveries it logs `credential_setup.cleanup_abandoned` and clears the marker.
- New DO columns `cleanup_pending`, `cleanup_from_status` and `cleanup_attempts` are added by a guarded `ALTER TABLE ADD COLUMN` (checked against `PRAGMA table_info`). The table is not recreated.
- The scrub is skipped when teardown starts from `provisioning`. When the scrub does run, it is bounded by `withTimeout` at `SANDBOX_EXEC_TIMEOUT_MS` (default 30 s), the same existing knob that bounds `destroySandboxInstance`. No new env var was added.
- Tests: `apps/api/tests/unit/durable-objects/credential-setup-session-teardown.test.ts` (real SQLite for DO storage and D1, real create route). Each of the six fixes was reverted on its own, and a test went red each time.
- Resumed (post-crash) cleanup also skips the scrub: on celld the exec started a fresh empty container just to scrub it.
- Fourth criterion: `SandboxDO` (`apps/api/src/durable-objects/sandbox-do.ts`) overrides the SDK's public `containerFetch`. A 503 startup answer whose engine error is permanent (`services/sandbox-startup-errors.ts`, `PERMANENT_ENGINE_START_ERRORS`) becomes the SDK's own permanent 500. celld carries the real error only in the rejection of the run's `ctx.container.monitor()` promise, so the subclass tees that public API (re-probing once celld opens a late run). `provision()` maps it to `sandbox_runtime_unavailable`. Verified on the prototype box: proxy refusal 1.3-1.9 s (4 runs), unregistered runsc 1.5-1.6 s (2 runs).
