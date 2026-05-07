# P2-03: Enable Go Race Detector in CI

**Phase**: 2 (Testing Foundation)
**Priority**: P1
**Risk Level**: Low — CI config change only
**Effort**: S (2-4 hours)
**Source Findings**: F-023 (Track 6: Testing)
**Recommended Skill(s)**: `$go-specialist`

## Scope

The `vm-agent-test` CI job runs `go test ./...` without the `-race` flag. The Go race detector is the primary tool for catching concurrent access bugs in the VM agent, which manages PTY sessions, WebSocket connections, Docker containers, and ACP message serialization.

## Files Likely Touched

- `.github/workflows/ci.yml` — add `-race` flag to `vm-agent-test` job
- `packages/vm-agent/` — fix any pre-existing race failures discovered

## Compatibility Constraints

- CI job must complete within existing 15-minute timeout (race detector adds ~2-3x slowdown)
- Any pre-existing races found must be fixed or documented as blockers before merging

## Automated Tests to Add/Run

- `go test -race ./...` in `packages/vm-agent/`
- CI pipeline must remain green

## Manual Staging Verification

- N/A — CI config change only

## Expected Current Staging State Dependency

- None

## Expected Post-Deploy State

- CI catches concurrent access bugs in Go code automatically
- Any pre-existing races are fixed

## Visible Behavior Changes

- None to end users
- CI Go test job runs slightly slower (~2-3x) but catches race conditions

## Rollback Notes

- Remove `-race` flag from CI config. No state to clean up.

## Acceptance Criteria

- [ ] `.github/workflows/ci.yml` `vm-agent-test` job uses `go test -race ./...`
- [ ] CI completes within existing timeout
- [ ] No pre-existing tests fail with race detector enabled (fix any discovered races)

## Links

- Track report: `tracks/06-testing-experiments.md` (Section: Go Race Detector)
- Finding: F-023 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 3, Task 3C
- Existing backlog: `tasks/backlog/2026-03-03-improve-test-infrastructure.md:18`
