# Workspace Isolation via Canonical Identity Keys

**Status:** backlog
**Priority:** critical
**Type:** bug fix + architecture hardening
**Created:** 2026-02-19

## Problem Statement

Running multiple workspaces for the same repository on a single node can cause runtime collisions. Workspaces can resolve to the same runtime container/workdir, which makes `git status` and file changes appear shared across workspaces.

This breaks the core isolation guarantee. A workspace must be an independent runtime, even when repository + branch are identical.

## Root Cause Summary

Current runtime identity and lookup paths use repo-derived readable values in places that require unique machine identity (workspace runtime path/label/container discovery). Repo-derived labels are not unique.

## Non-Negotiable Principle

Human labels are for UX only. Canonical IDs are the only valid uniqueness keys for runtime resources and lifecycle operations.

## Scope

- VM Agent workspace runtime identity model
- Container discovery and workspace resolution
- Devcontainer provisioning/reuse checks
- Deletion/rebuild safety when multiple same-repo workspaces exist on one node
- Tests and docs updates

## Goals

1. Allow N workspaces of the same repo on one node with complete filesystem/runtime isolation.
2. Ensure workspace lifecycle operations target only the intended workspace resources.
3. Preserve readable labels for UX/observability without using them as identity keys.

## Acceptance Criteria

- [ ] Creating multiple same-repo workspaces on one node yields distinct runtime identities.
- [ ] Distinct container lookup keys are derived from canonical workspace IDs.
- [ ] Distinct workspace directories/workdirs are derived from canonical workspace IDs (or equivalent unique canonical key).
- [ ] Rebuild/restart/stop/delete of one workspace cannot affect another same-repo workspace.
- [ ] `git status`/file APIs for one workspace never surface changes from another workspace.
- [ ] Regression tests cover same-repo multi-workspace isolation.
- [ ] Documentation updated in same PR/commit where behavior changes.

## Implementation Plan

### Phase 1: Identity Model Corrections

- [ ] Define canonical runtime identity fields for each workspace:
  - machine key (workspace ID)
  - human label (repo-derived, display only)
- [ ] Stop deriving unique runtime keys from repo names.

### Phase 2: Provisioning + Discovery Fixes

- [ ] Ensure devcontainer lookup and "already running" checks are keyed by canonical identity.
- [ ] Ensure workspace runtime paths/labels used for machine lookup are canonical and unique.
- [ ] Keep human-readable metadata separately for logs/UI.

### Phase 3: Lifecycle Safety

- [ ] Verify stop/restart/rebuild/delete target only canonical workspace resources.
- [ ] Prevent label collisions from causing cross-workspace container removal.

### Phase 4: Tests

- [ ] Add tests for same-repo multi-workspace create/provision behavior.
- [ ] Add tests for container discovery uniqueness and no cross-routing.
- [ ] Add tests for delete isolation (workspace A delete does not remove B resources).

### Phase 5: Documentation

- [ ] Update `AGENTS.md` and `CLAUDE.md` with canonical-ID-vs-label principle.
- [ ] Update architecture/guides docs that describe workspace runtime identity behavior.

## Risks

- Legacy runtimes provisioned under older label/path semantics may require compatibility handling during rollout.
- Any migration path must avoid breaking active workspaces during agent restart/recovery.

## Validation Strategy

- Unit tests for identity derivation and lookup filters.
- Integration tests for two same-repo workspaces on one node.
- Local package tests (`packages/vm-agent`) plus impacted API/web tests if contracts changed.
