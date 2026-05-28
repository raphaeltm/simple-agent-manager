# Workspace Forward CLI Staging Verification

## Problem

The workspace port forwarding CLI shipped without a true end-to-end staging test. Endpoint-only checks did not prove that a user can authenticate the CLI, forward a real workspace port, and receive a response from a server running inside a staging workspace.

## Research Findings

- Prior session `fb574c76-69ac-43e5-8e12-90940f4e3ddf` confirmed no running staging workspace was used before merge.
- `packages/cli/internal/cli/workspace.go` implements `sam workspace <id> forward`, binding `127.0.0.1:<port>` and proxying to `https://ws-<workspaceId>--<port>.<baseDomain>` with a `port_token`.
- `packages/cli/internal/cli/client.go` sends the BetterAuth session cookie in the `Cookie` header for `GET /api/workspaces/:id`, `/ports`, and `/port-access`.
- `apps/api/src/routes/workspaces/crud.ts` exposes `/ports` and JSON-capable `/port-access`.
- `apps/api/src/routes/terminal.ts` can mint a terminal token for a running workspace.
- `apps/web/src/pages/workspace/useWorkspaceCore.ts` and `packages/terminal/src/protocol.ts` show the WebSocket URL/protocol for running shell commands inside a workspace.
- `.claude/rules/13-staging-verification.md` and `.claude/rules/33-staging-feature-validation.md` require real staging feature validation, not empty-state or endpoint-only checks.

## Checklist

- [x] Create or select a real running staging workspace owned by the smoke-test user.
- [x] Use the terminal WebSocket or an equivalent user path to start a trivial HTTP server on port 3000 inside that workspace.
- [x] Build the current Go CLI locally.
- [x] Authenticate the CLI against staging with the smoke-test user BetterAuth session cookie.
- [ ] Run `sam workspace <workspaceId> ports` and confirm port 3000 is detected or manually forward it with `--port 3000`.
- [ ] Run `sam workspace <workspaceId> forward --port 3000`.
- [ ] Verify `curl http://127.0.0.1:3000` returns the server response through the CLI proxy.
- [x] If the CLI fails, inspect staging state/logs first, fix the CLI or API as needed, then repeat.
- [ ] Clean up the test server and any test workspace/node created for validation.
- [ ] Record staging evidence and independent validator result.

## Acceptance Criteria

- [ ] The end-to-end CLI forwarding flow works on staging with a real running workspace and a real server response from `localhost:3000`.
- [ ] Any CLI/API defects discovered during staging are fixed and covered by tests.
- [ ] If code changes are required, all required quality gates, specialist reviews, staging deployment, PR, and post-merge monitoring are completed via `/do`.

