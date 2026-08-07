# Investigate staging VM-agent no-heartbeat before workspace creation

**Status**: backlog
**Created**: 2026-08-07
**Source**: PR #1760 staging validation A/B

## Problem

New staging task attempts can provision a Hetzner node but the VM agent never checks in:
`nodes.last_heartbeat_at` remains `NULL`, `nodes.agent_ready_at` remains `NULL`, and no usable
workspace is created.

This blocks real-task staging validation even when the app/API deploy and smoke tests pass.

## Evidence

Candidate branch `sam/fix-platform-idle-cleanup-prarzs`:

- Staging deploy `31137108222` succeeded at `b2fcea7ee2ed7a8d6fac513f60c8bb11f483e21e`.
- Task `01KZCX7S44HMCX17TB1ENNQW3M` provisioned node `01KZCX7WAH9V20DQQHDAQ368BA`
  (`provider_instance_id=159817861`) but no heartbeat/ready signal arrived.
- Task `01KZCXDM3AWJBQWDNGGQR5FRBX` provisioned node `01KZCXDQ6HZ44FQZ0KGV18H37D`
  (`provider_instance_id=159818581`) but no heartbeat/ready signal arrived.

Baseline current `main`:

- Staging deploy `31145298435` succeeded at `a45e0c50838dcc06f995d2fa4921cf54ab42dd8a`.
- Task `01KZD60ZZ1WWE02ME85799TSV9` provisioned node `01KZD6136DJ23QYBGPCC99056Q`
  (`provider_instance_id=159855150`) but no heartbeat/ready signal arrived.

All probe nodes were deleted via the API after cancellation. Final staging state was
`running_nodes=0` and `running_workspaces=0`.

Production read-only check at 2026-08-07T04:06Z showed 4 running production nodes, all with
heartbeats, and a fresh latest heartbeat (`2026-08-07T04:06:24.070Z`). This suggests existing
production VM-agent fleet health is intact, while new staging node bootstrap needs investigation.

## Acceptance Criteria

- Identify why staging VMs provision successfully but VM agent `/ready` and `/heartbeat` never reach
  the API.
- Capture VM bootstrap/cloud-init/systemd logs for a failing staging node.
- Fix staging bootstrap or configuration so a controlled real task reaches a usable workspace.
- Verify cleanup returns staging to zero running nodes/workspaces.
