# MCP Token Plaintext Storage in Durable Object State

> **Reconciliation 2026-10-05:** The cited `durable-objects/task-runner.ts:89,860-861` predates the TaskRunner split. The token is now set at `apps/api/src/durable-objects/task-runner/agent-session-step.ts:105-132` and persisted unredacted through `task-runner/attempt-storage.ts:5-18`. It is redacted only in `task-runner/status.ts:4-5` and revoked only on failure (`task-runner/state-machine.ts:456-467`). #2230's wake reset nulls it without revoking it, which matches the existing TTL-only expiry for runs that did not fail: no new exposure, scope unchanged.

**Created**: 2026-03-17
**Source**: Security audit of fix/mcp-token-ttl-alignment branch

## Problem

The raw MCP bearer token (UUID) is stored in plaintext in TaskRunner Durable Object persistent state (`state.stepResults.mcpToken`). While `getStatus()` redacts the token for the external API, the underlying DO SQLite storage contains the live bearer credential for the full task duration (up to 4 hours).

This is pre-existing behavior (not introduced by the TTL fix), but the extended TTL increases the exposure window.

## Acceptance Criteria

- [ ] Raw MCP token is NOT stored in DO persistent state
- [ ] Task-runner can still perform retry-idempotency checks (avoid issuing duplicate tokens)
- [ ] Token revocation on task failure still works
- [ ] All existing MCP token tests pass

## Implementation Notes

Options:
1. Store only the KV key reference (deterministically derived from task ID) instead of the token value
2. Store an HMAC of the token for idempotency checks
3. Store a boolean `mcpTokenIssued` flag instead of the token itself

The task-runner already knows the task ID, which could be used to derive the KV key deterministically.

## References

- Security auditor finding from PR fixing MCP token TTL alignment
- `apps/api/src/durable-objects/task-runner.ts:89, 860-861`
