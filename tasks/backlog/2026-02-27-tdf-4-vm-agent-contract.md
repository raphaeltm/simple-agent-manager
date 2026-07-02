# TDF-4: VM Agent Communication Contract — Formalized API Boundary

**Created**: 2026-02-27
**Priority**: Medium
**Classification**: `cross-component-change`, `external-api-change`
**Dependencies**: None (independent — defines the boundary)
**Blocked by**: Nothing
**Blocks**: TDF-5 (Workspace Lifecycle — depends on this contract)

---

## Context

The control plane (Cloudflare Worker, TypeScript) communicates with the VM agent (Go, on Hetzner VM) via HTTP. This is the most critical system boundary — two different runtimes, two different languages, communicating over the network. If either side misunderstands the contract, state diverges silently.

Our research identified several failure modes at this boundary:
- The `markWorkspaceReady()` callback is a single HTTP attempt with no retry
- Callback JWT validation has no shared test suite
- Error response formats aren't formalized
- Timeout behavior differs between caller and callee expectations

### Research References

- **Flow map**: `docs/task-delegation-flow-map.md` — "Phase 3: VM Execution", "Phase 4: Callback Processing"
- **Analysis**: `docs/notes/task-delegation-system-analysis.md` — "Workspace Readiness Chain" sequence diagram
- **Control plane client**: `apps/api/src/services/node-agent.ts`
- **VM agent server**: `packages/vm-agent/internal/server/server.go`
- **VM workspace handling**: `packages/vm-agent/internal/server/workspaces.go`
- **Bootstrap/callback**: `packages/vm-agent/internal/bootstrap/bootstrap.go`
- **Message reporter**: `packages/vm-agent/internal/messagereport/`

---

## Problem Statement

The HTTP contract between control plane and VM agent is implicit — defined by what the code happens to send and accept, not by a formal specification. This means:

1. **No shared schema** — TypeScript types and Go structs can drift without either side knowing
2. **Callback reliability** — `markWorkspaceReady()` and `notifyProvisioningFailed()` are single-attempt fire-and-forget. A network blip means permanent state divergence.
3. **No contract tests** — Neither side tests against the other's expectations
4. **Error handling asymmetry** — The control plane expects certain error codes, the VM agent may return different ones
5. **JWT validation** — Callback tokens are signed by the control plane and verified by... the control plane when the VM calls back. The token format, claims, and expiry need formal definition.
6. **Message batch API** — The batch message persistence endpoint has deduplication semantics that the VM agent relies on but doesn't test against

---

## Scope

### In Scope

- Document the full HTTP API contract (request/response schemas, status codes, error formats)
- Create shared type definitions or JSON schemas that both sides can validate against
- Add contract tests: TypeScript client tests that validate payloads match expected schemas
- Add contract tests: Go server tests that validate request parsing and response formatting
- Formalize callback JWT token format (claims, expiry, validation rules)
- Add retry logic to critical callbacks (markWorkspaceReady, provisioningFailed, task status)
- Test timeout behavior on both sides
- Test message batch API deduplication contract

### Out of Scope

- Changing what the endpoints DO (that's TDF-5 for workspace lifecycle)
- The orchestration engine (TDF-2)
- WebSocket protocol for terminal streaming (separate concern)

---

## Acceptance Criteria

- [ ] Documented API contract for every endpoint between control plane and VM agent
- [ ] Shared JSON schemas or type definitions for all request/response payloads
- [ ] Contract tests on TypeScript side: client sends payloads matching the schema
- [ ] Contract tests on Go side: server parses requests and returns responses matching the schema
- [ ] Callback JWT format documented: required claims, expiry duration, signing algorithm
- [ ] JWT validation tests on the control plane callback handler
- [ ] Retry logic added to `markWorkspaceReady()` and `notifyProvisioningFailed()` in the VM agent
- [ ] Retry logic tested: success after N retries, failure after max retries
- [ ] Timeout behavior tested: control plane client timeout, VM agent request timeout
- [ ] Message batch deduplication contract tested: same messageId sent twice, only one persisted
- [ ] Error response format standardized and tested on both sides
- [ ] All tests pass in CI

---

## API Endpoints to Formalize

### Control Plane → VM Agent

| Endpoint | Method | Purpose | Current File |
|----------|--------|---------|-------------|
| `/health` | GET | Agent health check | `server.go` |
| `/workspaces` | POST | Create workspace | `server.go` → `workspaces.go` |
| `/workspaces/:id` | DELETE | Stop/remove workspace | `workspaces.go` |
| `/workspaces/:id/agent-sessions` | POST | Start agent session | `server.go` |
| `/workspaces/:id/agent-sessions/:sid` | DELETE | Stop agent session | `server.go` |

### VM Agent → Control Plane (Callbacks)

| Endpoint | Method | Purpose | Current File |
|----------|--------|---------|-------------|
| `/api/workspaces/:id/ready` | POST | Workspace provisioned successfully | `bootstrap.go` |
| `/api/workspaces/:id/provisioning-failed` | POST | Workspace provisioning failed | `workspaces.go` |
| `/api/tasks/:id/status/callback` | POST | Task status update / completion | `server.go` |
| `/api/projects/:pid/workspaces/:wid/messages/batch` | POST | Batch message persistence | `messagereport/` |

---

## Testing Requirements

### Contract Tests (TypeScript)

| Test Category | What to Test |
|--------------|-------------|
| Request payloads | Each client method sends the correct JSON structure |
| Response parsing | Client correctly handles success, error, and timeout responses |
| JWT token signing | Callback tokens have correct claims and expiry |
| Error handling | Client handles 4xx, 5xx, timeout, connection refused |

### Contract Tests (Go)

| Test Category | What to Test |
|--------------|-------------|
| Request parsing | Each handler correctly deserializes the request body |
| Response formatting | Each handler returns the documented JSON structure |
| JWT validation | Callback tokens are validated with correct claims |
| Error responses | Handlers return standardized error format |
| Retry logic | Callbacks retry on transient failures, give up on permanent ones |

### Integration Tests

| Test Category | What to Test |
|--------------|-------------|
| Round-trip | TypeScript client → mock Go server → validate request → return response → validate on client |
| Callback round-trip | Go callback → mock TypeScript handler → validate payload → return response |
| Message batch dedup | Send same batch twice, verify only one set persisted |

---

## Key Files

| File | Action |
|------|--------|
| `apps/api/src/services/node-agent.ts` | Add timeout handling, document expected schemas |
| `packages/vm-agent/internal/server/server.go` | Validate request schemas, standardize error responses |
| `packages/vm-agent/internal/server/workspaces.go` | Add retry to callbacks |
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | Add retry to markWorkspaceReady |
| `packages/vm-agent/internal/messagereport/` | Test batch dedup contract |
| `packages/shared/src/types.ts` | Add shared API contract types |
| `apps/api/tests/unit/node-agent-contract.test.ts` | Create contract tests |
| `packages/vm-agent/internal/server/contract_test.go` | Create Go contract tests |
