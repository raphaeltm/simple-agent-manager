# P4-04: Split Oversized VM Agent Packages

**Phase**: 4 (Performance & Code Organization)
**Priority**: P1
**Risk Level**: Medium — Go package refactoring
**Effort**: XL (3-5 days)
**Source Findings**: F-012, F-013 (Track 3: Code Organization)
**Recommended Skill(s)**: `$go-specialist`

## Scope

The VM agent `internal/server/` package is 9,303 lines and `session_host.go` is 2,535 lines. Split along package responsibilities without behavior changes. Public interfaces must remain small and documented.

## Files Likely Touched

- `packages/vm-agent/internal/server/` — split into sub-packages
- `packages/vm-agent/internal/acp/session_host.go` — extract method groups
- New sub-packages under `internal/` as needed

## Compatibility Constraints

- No behavior changes — pure refactoring
- Go tests must pass with race detector: `go test -race ./...`
- Public interfaces must remain backward compatible
- Binary size should not increase significantly

## Automated Tests to Add/Run

- All existing Go tests must pass unchanged
- `go test -race ./...` must pass
- `go vet ./...` must pass
- `go build ./...` must succeed

## Manual Staging Verification

- Deploy to staging, provision a workspace, verify VM agent starts and heartbeats arrive
- Verify agent sessions work end-to-end

## Expected Post-Deploy State

- `internal/server/` split into sub-packages by responsibility
- `session_host.go` functions extracted into logical method groups
- Public interfaces documented and small

## Visible Behavior Changes

- None

## Rollback Notes

- Revert to monolithic package. Pure refactoring — no data or state to clean up.

## Acceptance Criteria

- [ ] `internal/server/` split along package responsibilities
- [ ] No single Go file exceeds 800 lines (excluding tests)
- [ ] Go tests pass with race detector
- [ ] Public interfaces remain small and documented
- [ ] No behavior changes — refactoring only

## Links

- Track report: `tracks/03-code-organization.md` (Section: VM Agent)
- Findings: F-012, F-013 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 4, Task 4C
