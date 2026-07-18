# Harden VM agent PTY close and single-terminal disconnect cleanup

## Context

CLI/VM/Go audit task `01KXT1F6JSDV3J5CJ22TGXRGAV` recommended splitting out two narrow VM agent remediation items:

- Fix single-terminal disconnect cleanup.
- Harden PTY close with timeout/SIGKILL escalation.

Relevant session: `fd408b7a-4b2e-4684-a290-285d03a88d63`.

## Scope

Implement a tightly targeted, backward-compatible VM agent cleanup hardening PR.

## Checklist

- [ ] Research `packages/vm-agent` PTY/session cleanup paths and existing tests.
- [ ] Ensure legacy single-terminal WebSocket disconnect releases its PTY resources predictably.
- [ ] Preserve multi-terminal disconnect behavior: attached terminal sessions are orphaned for reattach instead of closed.
- [ ] Make PTY `Close` attempt graceful termination first, then escalate to SIGKILL after a bounded timeout.
- [ ] Add deterministic Go tests for disconnect cleanup and forced termination behavior without flaky sleeps.
- [ ] Run Go tests and repo quality checks.
- [ ] Open a PR that states no breaking changes and includes test evidence.

## Constraints

- Do not merge the PR.
- Do not change the terminal protocol.
- Do not break multi-terminal behavior or crash recovery.
