# Guided credential setup: teardown leaves D1 active and waits on a dead container

## Problem

Found while prototyping guided login on celld (task 01M769WDVM4HCQ7185R8E2QGV6, notes on idea 01M75V57RG8GR4NA0KC91TM1J7, 2026-11-11). Applies to every runtime.

1. `CredentialSetupSession.teardown` (`apps/api/src/durable-objects/credential-setup-session/index.ts`) claims the terminal status in DO SQLite first. It then awaits the sandbox scrub `exec` and `destroySandboxInstance`, and only after those writes D1. If the isolate or process dies in between, the DO is terminal but D1 stays active. `POST /api/agent-credential-setup-sessions` keeps returning the dead session for that user and agent (the `existingActive` lookup) until `runSetupSessionSweep` reclaims the row after `expires_at`. That was about 19 minutes on the prototype box, which blocked retries.
2. When the container never started (runtime missing, image missing), the scrub `exec` restarts the container. Teardown then waits through the Sandbox SDK's ~150 s start-retry window before it destroys the container.
3. A start failure such as `unknown or invalid runtime name`, `No such image` or `RuntimeFailed` reaches the user only after the SDK's ~150 s retries. The prototype showed "Preparing secure sign-in…" for 137 s.

## Acceptance Criteria

- [ ] D1 is marked terminal before any sandbox I/O in teardown, or create treats a DO-terminal row as inactive.
- [ ] A restarted alarm completes an interrupted cleanup (scrub, destroy, pool release).
- [ ] The scrub is skipped when provisioning never reached a running container, and scrub and destroy have short env-configurable timeouts.
- [ ] Permanent container start errors fail the session promptly with a distinguishable error code.
- [ ] Tests: interrupted teardown (the process dies after the DO claim) followed by a new create for the same user and agent, and a never-started container being torn down without a 150 s wait.
