# Public Workspace Ports Toggle

GitHub issue: https://github.com/raphaeltm/simple-agent-manager/issues/1176

## Problem

Workspace port forwarding currently depends on per-port browser access tokens. That keeps forwarded ports private, but it also creates fragile auth behavior for dev servers that expect to run at a stable public URL. Users need an explicit opt-in switch in the project chat header that makes forwarded ports public for the current workspace so preview URLs work without token/cookie auth issues.

## Research Findings

- `apps/api/src/index.ts` routes `ws-{workspace}--{port}.{BASE_DOMAIN}` to the VM agent port proxy. It currently requires `sam_port_access` or `port_token` before it looks up workspace routing metadata.
- `apps/api/src/routes/workspaces/crud.ts` exposes `GET /api/workspaces/:id/port-access` to mint a per-port signed URL and `GET /api/workspaces/:id/ports` to list detected ports through the node agent.
- `apps/web/src/components/project-message-view/SessionHeader.tsx` is the project chat header that already renders active port badges in the compact row and the expanded details panel.
- `apps/web/src/lib/api/workspaces.ts` owns workspace API helpers and `getPortAccessUrl`.
- `packages/shared/src/types/workspace.ts` defines `WorkspaceResponse`; adding the public flag there keeps API and web state typed.
- `apps/api/tests/unit/workspace-proxy-port-access.test.ts` already covers token/cookie proxy auth and is the right place to pin public-port bypass behavior.

## Implementation Checklist

- [x] Add a D1 workspace flag for public forwarded ports.
- [x] Include the flag in shared workspace types and API workspace responses.
- [x] Add an authenticated workspace endpoint to update the flag.
- [x] Teach the edge workspace proxy to allow tokenless port proxy requests only when the workspace flag is enabled.
- [x] Add web API helper for the toggle.
- [x] Add a project chat header switch below the active ports list in the compact session header.
- [x] Use direct forwarded-port URLs in the header when public mode is enabled, preserving signed access URLs when it is disabled.
- [x] Add focused API and UI tests.
- [x] Run validation: API/web unit tests, typecheck, lint, build as feasible.
- [x] Run screenshot-backed UI audit for mobile and desktop.

## Acceptance Criteria

- Users can opt in per workspace to make all detected forwarded ports public.
- When disabled, existing `port_token`/cookie behavior is unchanged.
- When enabled, direct `ws-{workspace}--{port}` requests proxy without a browser token, but non-port workspace routes still require normal auth.
- The switch has clear enabled/disabled/loading/error states and is reachable in the project chat session header.
- The implementation does not expose ports for workspaces that are stopped, missing, or not opted in.
