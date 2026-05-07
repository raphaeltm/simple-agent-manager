# P3-04: Callback Token/JWT Hardening

**Phase**: 3 (Security & Data Integrity)
**Priority**: P0
**Risk Level**: High — modifies authentication mechanisms
**Effort**: M (1-2 days)
**Source Findings**: F-004 (Track 7: Security), F-010 (Track 2: Data Flow)
**Recommended Skill(s)**: `$security-auditor`, `$go-specialist`
**BLOCKED**: Until Phase 2 testing foundation is in place and human reviews this plan

## Scope

Callback token validation is split across multiple paths (Worker callback auth vs VM agent callback flow), and bootstrap material needs stricter lifecycle handling. This packet unifies the validation contract and hardens bootstrap token storage.

## Files Likely Touched

- Callback auth services in `apps/api/src/services/` — unify validation contract
- VM agent callback validation in `packages/vm-agent/` — align with unified contract
- Bootstrap KV handling — minimize token/JWT storage lifecycle
- `apps/api/tests/` — cross-boundary contract tests
- `packages/vm-agent/` tests — corresponding Go tests

## Compatibility Constraints

- Worker and VM agent must remain compatible during rollout
- Existing workspace sessions must not be interrupted
- Bootstrap token semantics (one-time use, time-limited) must be preserved
- No change to the external API surface

## Automated Tests to Add/Run

- Contract test covering: auth mechanism, request shape, failure modes
- Test: Worker callback validation matches VM agent callback validation
- Test: bootstrap token lifecycle — created, used once, expired, cannot be reused
- Test: JWT with expired/invalid/revoked state → rejected
- API unit tests: `pnpm --filter @simple-agent-manager/api test`
- VM agent Go tests: `go test -race ./...` in `packages/vm-agent/`

## Manual Staging Verification

- Submit a task → verify workspace provisions and agent connects (callback auth works)
- Verify bootstrap token is consumed during provisioning
- Verify subsequent use of same bootstrap token fails
- Verify callback auth rejects invalid/expired tokens

## Expected Current Staging State Dependency

- Ability to provision workspaces (node available)
- Task submission working end-to-end

## Expected Post-Deploy State

- Callback validation has one documented contract shared between Worker and VM agent
- Bootstrap token lifecycle is minimized (shorter TTL, cleared after use)
- Cross-boundary contract test prevents future drift

## Visible Behavior Changes

- None under normal operation
- Edge case: bootstrap tokens that were previously valid slightly longer may now expire sooner

## Rollback Notes

- Revert both Worker and VM agent changes together (they must stay in sync)
- If only one side is reverted, the other may reject valid callbacks
- **Risk**: Partial rollback breaks callback auth. Full rollback re-introduces the split validation paths.

## Acceptance Criteria

- [ ] Worker and VM agent callback validation share one documented contract
- [ ] Bootstrap token/JWT storage lifecycle is minimized and tested
- [ ] Contract test covers auth mechanism, request shape, and failure modes
- [ ] Cross-boundary contract test prevents future drift between Worker and VM agent
- [ ] API unit tests plus VM agent Go tests pass
- [ ] Security review before merge

## Links

- Track report: `tracks/07-security-isolation.md` (HIGH-3: Callback JWT, HIGH-4: JWT Revocation)
- Track report: `tracks/02-data-flow.md` (DF-01: Dual Callback Paths)
- Findings: F-004, F-010 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 1, Task 1D
