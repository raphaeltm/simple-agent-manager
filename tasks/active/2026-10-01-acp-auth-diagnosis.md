# ACP Slice D: isolated authentication diagnosis

## Problem

Session failures need to distinguish agent credential problems, MCP endpoint authentication, unsupported local callback flows, and model access failures. A generic credential prompt can mislead a user whose account cannot use the selected model.

## Research

- Approved v2 plan: SAM Idea `01M3P2E0JJNQRXX020P65ZRKEJ`.
- `packages/shared/src/failure-classification.ts` already classifies task failure text and drives the real chat `FailureCard`.
- `SettingsConnections` is `/settings/connections`; personal `SettingsMcpServers` is `/settings/mcp-servers`.
- C2 draft #2207 owns URL bridge/contracts; activation draft #2204 owns flags. Neither belongs in this slice.
- The real chat failure card receives `session.isMine`, so personal settings actions can be restricted to the creator.

## Checklist

- [x] Add narrow auth and model-availability classifications with conservative negative cases.
- [x] Emit safe structural reason codes for recognized VM agent-key and prompt auth failures.
- [x] Show existing settings actions in the real chat failure card only for the session creator.
- [x] Add unit tests for cross-provider distinctions, role restrictions, and static guidance with secret canaries.
- [x] Add real-chat Playwright click tests on mobile and desktop and personally inspect screenshots.
- [x] Update public agent/MCP troubleshooting guidance.
- [x] Finish full checks and specialist validation.
- [x] Create draft PR [#2209](https://github.com/raphaeltm/simple-agent-manager/pull/2209) and send exact handoff evidence to coordinator before staging.

## Acceptance / limits

This slice diagnoses recognized task error reasons and displays static guidance. It adds no new API/event shape, does not change C2 URL data, activate interactions, perform provider login in a session, or assert a remote service's authentication succeeds. The coordinator owns final runtime/harness validation and staging slot.

The VM only identifies a missing connection when the existing agent-key endpoint returns its exact `NOT_FOUND` / `Agent credential not found` response. Workspace 404 and malformed/empty 200 responses remain generic. MCP and loopback reason codes require a structural source; arbitrary MCP 401 or localhost text in an ACP error is deliberately not promoted to an auth diagnosis. The final C2/activation matrix must verify when those structural reasons are emitted.

## Verification

- Shared failure-classification tests: 41 passed. Web failure-card tests: 21 passed. VM agent `go test ./...` and local mock/Worker VM smoke passed; focused callback and credential tests passed after final edits. Smoke fixtures now use the current API error envelope and fixed reason code.
- Root lint, typecheck, and build passed. Root test had three API timeouts under parallel load; the exact three files passed on isolated rerun (104 tests).
- Real-chat Playwright includes creator/member restrictions, actual settings navigation, trailing-status persistence, and clearing after a new turn across phone, tablet, and desktop viewports. Reviewed screenshots are under `tasks/evidence/acp-slice-d/`.
- Security/Go, UI/docs, constitution, and task-completion reviews found no remaining blocker.
