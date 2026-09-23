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
- [x] Run `sam workspace <workspaceId> ports` and confirm port 3000 is detected or manually forward it with `--port 3000`.
- [x] Run `sam workspace <workspaceId> forward --port 3000`.
- [x] Verify `curl http://127.0.0.1:3000` returns the server response through the CLI proxy.
- [x] If the CLI fails, inspect staging state/logs first, fix the CLI or API as needed, then repeat.
- [x] Clean up the test server and any test workspace/node created for validation.
- [ ] Record staging evidence and independent validator result.

## Acceptance Criteria

- [x] The end-to-end CLI forwarding flow works on staging with a real running workspace and a real server response from `localhost:3000`.
- [x] Any CLI/API defects discovered during staging are fixed and covered by tests.
- [ ] If code changes are required, all required quality gates, specialist reviews, staging deployment, PR, and post-merge monitoring are completed via `/do`.


## Staging Evidence

- Created staging workspace `01KSP75VWY0JGT6H3XNGVKWRKV` on node `01KSP75VF7CJSQAWHVCPCQMEJD`; workspace reached `running`.
- Started a Node HTTP server on port 3000 inside the workspace through the terminal WebSocket.
- Initial staging test found `sam workspace <workspaceId> ports --json` returned HTTP 500 because the API used node-management auth against a VM-agent workspace endpoint. Fixed by using a workspace terminal token for VM-agent port listing.
- After staging deploy `26551679057`, `sam workspace <workspaceId> ports --json` detected port 3000.
- Initial local forward returned the Cloudflare port proxy bootstrap redirect (HTTP 302). Fixed the CLI reverse proxy to send `sam_port_access` as a cookie instead of `port_token` as a query parameter.
- Rebuilt the CLI and verified `curl http://127.0.0.1:3000` returned HTTP 200 with body `sam-cli-forward-ok`.

- Deleted staging workspace `01KSP75VWY0JGT6H3XNGVKWRKV`; API returned `{ "success": true }`.

## Review Evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1135
- Independent staging validator: `01KSP6X4RVHYYTRFMV9830HG2J` reproduced the CLI HTTP 302 issue that this PR fixes.
- Task completion validator: `01KSP8S0SNPGDP8ZD9T5VJK21Q` dispatched.
- Go specialist: `01KSP8SA4RRE33VV4CR4D1CV0G` dispatched.
- Cloudflare specialist: `01KSP8SJPP1SMCBCTPB4S9Y2GA` dispatched.
- Security auditor: `01KSP8STCSA5P1HVHSYW0JERXF` dispatched.
- Test engineer: `01KSP8T2H3D3PSWNVZDS4JGVQJ` dispatched.

## Local Review Results

- Local review results superseded the mistaken SAM-dispatched reviewer tasks after user clarification that `/do` subagents means local subagents.
- Go review: PASS, no blocking CLI proxy issues.
- Cloudflare/API review: PASS, workspace terminal token matches the VM-agent workspace endpoint auth contract.
- Security review: PASS, cookie-based port token forwarding reduces URL token leakage versus query strings.
- Task completion review: PASS, staging evidence and cleanup align with implementation.
- Test review: ADDRESSED in commit `3eb137d6`; the CLI test now simulates a remote 302 bootstrap response if `port_token` is sent in the query.
