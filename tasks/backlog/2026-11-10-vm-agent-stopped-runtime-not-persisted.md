# VM agent forgets a stopped workspace across an agent restart

## Problem

A stopped workspace that the agent rebuilds after a restart comes back as `running`.

- `persistence.WorkspaceMetadata` records `Evicted`, but nothing records that a workspace was
  stopped.
- After an agent restart, the first browser WebSocket attach rebuilds the runtime with
  `CreateStatus: "running"` (`packages/vm-agent/internal/server/workspace_request_auth.go`).
- This happens even when the workspace was stopped before the restart.

The PR for state-machine audit D3 stopped attach from overwriting the status of a runtime that
exists. A rebuilt runtime still has no stopped state to restore.

## Context

- Found by the Go review of `sam/state-machine-defect-fixes` (2026-11-10).
- Behaviour is unchanged from before that PR, so this is not a regression.
- Library report: `/engineering/research/state-machines-2026-11-10/00-state-machine-map.md`, section 4 P4.

## Acceptance criteria

- [ ] A stopped workspace is persisted as stopped, or an attach to a rebuilt runtime asks the control plane before assuming `running`.
- [ ] A Go test that drives an agent restart followed by a real WebSocket attach shows the stopped state survives.
- [ ] Workspaces that were running before the restart still come back as `running`.
