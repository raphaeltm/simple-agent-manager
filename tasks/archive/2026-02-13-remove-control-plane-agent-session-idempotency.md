# Remove Control-Plane KV Idempotency Layer for Agent Sessions

## Summary

The `agent-session-idempotency` KV lookup/write in the control plane is redundant. The VM agent's in-memory idempotency map already handles deduplication — the KV layer adds unnecessary complexity and burns scarce KV writes (1,000/day on free tier).

Agent session idempotency is a VM-local concern (preventing duplicate process spawns), not a control-plane concern.

## Changes

### Remove from control plane
- [ ] `apps/api/src/routes/workspaces.ts`: Remove `Idempotency-Key` header parsing, KV get/put for `agent-session-idempotency:*` keys, and the D1 lookup-by-existing-session-id branch
- [ ] `apps/api/src/services/node-agent.ts`: Remove `idempotencyKey` from `NodeAgentRequestOptions` and `createAgentSessionOnNode` signature, remove header forwarding

### Keep on VM agent (already correct)
- `packages/vm-agent/internal/agentsessions/manager.go`: In-memory idempotency map stays — it's the right layer for this

### Update tests
- [ ] `apps/api/tests/unit/routes/workspaces.test.ts`: Remove "implements idempotent session creation support" test
- [ ] `apps/api/tests/unit/routes/agent-sessions.test.ts`: Check for any idempotency-related assertions

### Update docs/specs
- [ ] `specs/014-multi-workspace-nodes/spec.md` FR-012a: Still satisfied — idempotency handled by VM agent
- [ ] `specs/014-multi-workspace-nodes/contracts/node-agent-api.md`: Verify `Idempotency-Key` header documented as VM agent concern
