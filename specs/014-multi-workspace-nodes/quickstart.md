# Quickstart: Multi-Workspace Nodes

**Feature**: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`  
**Created**: February 10, 2026

This quickstart describes the expected user flow once the Multi-Workspace Nodes feature is implemented.

## Prerequisites

- You are signed in to the Control Plane UI (`https://app.${BASE_DOMAIN}`).
- Your Hetzner account is connected in Settings (user-provided token stored encrypted).
- You have a GitHub App installation available for the repository you want to use.

## Create a Node

UI flow:
1. Go to Nodes.
2. Click Create Node.
3. Choose a name (and optionally size/location).
4. Wait for the Node to become Ready.

API flow (conceptual):
- `POST https://api.${BASE_DOMAIN}/api/nodes`

## Create Multiple Workspaces on the Same Node

UI flow:
1. Open a Node.
2. Click Create Workspace.
3. Select the repository and branch.
4. Provide a Workspace name.
5. Repeat to create Workspace B on the same Node.

Behavior:
- If you try to create two Workspaces with the same name on a Node, the system auto-adjusts the second name to a unique display name and shows you the final name.
- Workspaces are isolated: stopping or deleting Workspace A does not interrupt Workspace B.
- You can rename a Workspace later; if the target name already exists on the same Node, the system auto-adjusts to a unique final name.

API flow (conceptual):
- `POST https://api.${BASE_DOMAIN}/api/workspaces` with `nodeId`

## Open a Workspace and Start an Agent Session

UI flow:
1. From the Control Plane, open a Workspace details page.
2. Click Open Workspace (loads the Workspace UI via its `ws-{workspaceId}` address).
3. Click New Agent Session.
4. Attach to the running session (including after a browser refresh while the Workspace remains running).

Behavior:
- Agent Sessions do not survive Workspace stop/restart.
- Stopping/restarting a Workspace terminates all its Agent Sessions and they become non-attachable.
- By default, only one interactive attachment is active per Agent Session; a second attach shows a clear "already attached" conflict unless the user explicitly chooses takeover.
- Repeated "create session" actions caused by client retry use idempotency semantics to avoid duplicate sessions.

## Run Services Without Port Conflicts

Expected behavior:
- Two Workspaces on the same Node can run the same service ports concurrently (for example, both can run a web server on the same internal port) without conflicts.
- The system provides per-Workspace access so you can reach the correct Workspace's running services independently.

## Stop/Restart/Delete

- Stopping a Workspace preserves files/configuration but stops processes and sessions.
- Restarting a Workspace resumes the same Workspace files/configuration.
- Stopping a Node stops all Workspaces and Agent Sessions on that Node.
- Deleting a Node removes it from your list and makes its Workspaces and sessions inaccessible.
- This feature does not automatically shut down Nodes/Workspaces based on idle detection.
- Workspace/Node UI does not show idle-shutdown countdown warnings for this feature.

## Inspect Events and Logs

Expected behavior:
- You can view Node-level events/logs (for example, provisioning and Node Agent health events).
- You can view Workspace-level events/logs (for example, creation, restart, and failure events).
- Node health includes freshness/check-in information and a derived `healthy`/`stale`/`unhealthy` state so stale Nodes are visible in the Control Plane.
- Staleness uses a configurable threshold (for example `NODE_HEARTBEAT_STALE_SECONDS`), not a hardcoded timeout.

API flow (conceptual):
- `GET https://api.${BASE_DOMAIN}/api/nodes/{nodeId}/events`
- `GET https://api.${BASE_DOMAIN}/api/workspaces/{workspaceId}/events`

## Telemetry Capture (SC-002 / SC-006)

The implementation emits structured telemetry events/logs to support SC-002 and SC-006 evaluation in staging:

- `sc_002_workspace_creation_flow`
  - Captures whether workspace creation reused an existing node (`reusedExistingNode`)
  - Captures workspace count on that node before create (`workspaceCountOnNodeBefore`)
  - Captures per-user node/workspace totals (`nodeCountForUser`, `workspaceCountForUser`)

- `sc_006_node_efficiency`
  - Captures per-user node/workspace totals at node/workspace creation time
  - Supports tracking average nodes-per-workspace efficiency trend

Related transport telemetry (for routing and latency context):

- `ws_proxy_route`
- `node_agent_request`
- `node_agent_response` (includes status code and duration)

All telemetry records are logged as structured JSON with `event: "telemetry"` and an aggregate snapshot payload.

## Validation Checklist

Use this checklist when validating the feature end-to-end:

1. Create one node, then create two workspaces on that same node.
2. Confirm workspace list filtering by `nodeId` works in UI/API.
3. Rename one workspace to a duplicate name and verify auto-suffix uniqueness.
4. Create two agent sessions in one workspace, attach to one, then stop it.
5. Stop node and verify workspaces/sessions transition to stopped in UI.
6. Confirm node health state transitions (`healthy` -> `stale` -> `unhealthy`) appear based on heartbeat freshness.
7. Confirm telemetry events for `sc_002_workspace_creation_flow` and `sc_006_node_efficiency` are present in logs.
