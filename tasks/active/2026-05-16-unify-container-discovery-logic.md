# Unify Container Discovery Logic

## Problem

Bootstrap credential injection and ACP container discovery can select different running containers when duplicate devcontainers share the same workspace label. `findDevcontainerID()` currently uses `docker ps -q` and returns Docker's first default result, while `Discovery.GetContainerID()` sorts by creation timestamp descending and then container ID ascending.

This can inject environment variables or credentials into one container while the agent runs in another.

## Research Findings

- `packages/vm-agent/internal/container/discovery.go` already models Docker candidates as `containerCandidate{id, createdAt}` and sorts them inline in `discover()`.
- `packages/vm-agent/internal/container/discovery_test.go` already mocks Docker discovery via package-level vars, so a package-level stateless lookup can be unit-tested without Docker.
- `packages/vm-agent/internal/bootstrap/bootstrap.go` keeps `findDevcontainerID(ctx, cfg)` as a local helper used by bootstrap flows; it should remain a thin wrapper to avoid touching all call sites.
- `packages/vm-agent/internal/bootstrap/bootstrap_integration_test.go` has `TestIntegration_FindDevcontainerID`, which should still pass because the wrapper still returns a matching running container ID prefix.
- The referenced post-mortem path `docs/notes/2026-05-16-duplicate-workspace-dispatch-env-var-loss-postmortem.md` is not present in this checkout. Nearby devcontainer notes include `docs/notes/2026-05-04-devcontainer-gitconfig-lock-postmortem.md`, but no duplicate workspace dispatch note exists under `docs/notes/` at task start.

## Implementation Checklist

- [ ] Add package-level `sortCandidates` helper in the `container` package and update `discover()` to use it.
- [ ] Add exported stateless `FindContainerByLabel(ctx, labelKey, labelValue)` in the `container` package.
- [ ] Keep a code comment noting the current Docker delegate does not use `exec.CommandContext` directly.
- [ ] Replace bootstrap `findDevcontainerID()` body with a call to `container.FindContainerByLabel`.
- [ ] Add unit coverage for tie-breaking by lower container ID.
- [ ] Add unit coverage for selecting the newest candidate.
- [ ] Add unit coverage for no matching candidates returning an error.
- [ ] Verify focused VM agent tests, including the existing bootstrap integration test where feasible.

## Acceptance Criteria

- Bootstrap and ACP container discovery share the same candidate ordering.
- Duplicate containers with the same timestamp resolve to the lower container ID in both paths.
- Duplicate containers with different timestamps resolve to the newest container in both paths.
- No-candidate behavior still returns a clear error.
- Existing `findDevcontainerID(ctx, cfg)` call sites remain unchanged.
