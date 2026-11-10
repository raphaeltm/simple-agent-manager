# Managed VM tunnel staging verification

Status (2026-11-10 09:47 UTC): first managed staging sweep running; live findings fixed locally, final candidate redeployment and remaining lifecycle/fault checks pending.
The earlier CI-loopback experiments are transport feasibility evidence, not this
managed VM end-to-end proof. No production tunnel cutover is authorized here.

## Fixture and transport assertions

- Parent task: `01M719ZRT6MJX696B9FH8TBWX9`.
- Staging only: `sammy.party`.
- Owned Artifact project: `01M728XDW1JB2T08YCF2XR39H7` (`Tunnel E2E 2026-11-10`).
- VM full profile: `01M728XGQ9FHXR3VPJ847VXD67`.
- Instant profile: `01M728XHBQ93TEGAEJCCT89K0K`.
- Initial deployed candidate: `d38788564d71f0956d7046407e3a300e91f09dd5`, successful [run 42788029854](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42788029854).
- Exact initial agent release: `07b7a279b10d80981fb8b37393cfcffc6801f38c`.
- VM node `01M72C6GY6RFKSD9D6A1TX090V`, primary workspace `01M72CGEGDQDW0162ZZKK4P6AF`, session `b6b66d75-95f1-4601-b673-662e1d09cbb0`.
- Second workspace `01M72D3QJW8CR74JEMY9CK1ZFT` is on that same VM; session `94528a0b-b56d-4945-a599-6a2f6e254162`.
- Instant node `01M72CWK53HWK2QV8QHR0RS6KW`, workspace `01M72CWKDF0VKB48J3YRKYAW4N`, session `c156f907-cb25-4469-bb50-e79b81977bc9`.
- Budget: one small VM normally, two workspaces sharing its port 3000; one
  bounded instant fixture. Clean up owned compute immediately after testing.

The browser creates the chat using the selected real profile. Its agent builds,
starts and exposes an HTTP/WebSocket site on port 3000 and commits/pushes it through
normal Git authentication. No origin-IP request is used. The reusable helpers in
`scripts/e2e/cloudflare-tunnel-helpers.mjs` reject literal IP targets and destinations
outside the explicitly configured staging domain. Authentication files and raw
terminal output remain private; evidence contains selected assertions and IDs.

To establish the Worker-to-VM path, combine the D1 transport/incarnation journal,
Cloudflare CNAME/tunnel configuration and connector state, host listener/firewall
inspection, and a controlled connector outage. Browser URLs alone are insufficient.
Arm and verify an independent host recovery timer before stopping the connector.

## Endpoint-to-scenario matrix

The matrix defines coverage; only the explicit results below establish a live pass.

| Surface                    | Live scenario                                                                                         | Complementary local coverage                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning and callbacks | Fresh VM, expected binary SHA, boot phases, ready and heartbeat                                       | Real-SQL lifecycle tests: journal before VM, failed create/config/DNS/token, cancellation, capacity rejection, stale incarnation |
| Agent chat/ACP             | Agent creates site; streamed response; follow-up, steer, cancel and reconnect                         | Existing authenticated agent-session suites                                                                                      |
| MCP                        | Instructions, expose-port and normal agent progress operations                                        | Workspace MCP authorization and token-scoping suites                                                                             |
| HTTP preview               | HTML, asset bytes, path/query, POST body, redirects, 404 and streaming                                | Existing preview JWT/ownership/proxy tests                                                                                       |
| Preview WebSocket          | Text/binary echoes, idle connection, requested subprotocol                                            | Real workerd entrypoint test preserves upgraded socket while stripping cookies, VM and instant                                   |
| Private/public preview     | Private cookie handoff, anonymous denial, public toggle and closure                                   | Missing, invalid, expired and wrong-workspace tokens; reserved/self ports                                                        |
| Workspace isolation        | Two workspaces on one VM, each port 3000 returns its own marker                                       | Per-workspace routing and port-access tests                                                                                      |
| CLI forwarding             | Local HTTP forward, assets and POST through authenticated Worker                                      | Forward token/scope tests; WebSocket forwarding is explicitly unsupported by current CLI HTTP mode                               |
| Terminal                   | Create, input, resize, disconnect/reattach and scrollback                                             | Go terminal auth and protocol tests                                                                                              |
| Files and Git              | Upload/download exact bytes, file listing/view, Git status/diff and push                              | File-transfer and source/ownership checks                                                                                        |
| Host helper boundary       | Git helper works from Docker; external/tunnel and preview relay cannot reach private helper           | Dedicated tunnel listener context rejects loopback trust; actual handler tests                                                   |
| Diagnostics                | System info, events and log streaming through Worker                                                  | Node management token and ownership tests                                                                                        |
| Workspace lifecycle        | Create, rebuild, stop/restart and delete converge                                                     | Lifecycle cancellation/retry suites                                                                                              |
| Session persistence        | Sleep, wake, restored source and agent follow-up                                                      | Snapshot upload/restore suites                                                                                                   |
| Outage and reboot          | Stop connector: preview/control fail with no IP fallback; restart recovers; reboot reapplies firewall | Real netfilter reapplication and failure tests; every-start firewall gate; concurrent listener shutdown                          |
| Instant compatibility      | Agent/site 3000, HTTP/WS, terminal, files/Git, sleep/wake and cleanup; no tunnels created             | Real workerd preview upgrade and existing DO routing guards                                                                      |
| Final cleanup              | Owned VM/container gone, CNAME/tunnel deleted, journal converged                                      | Cleanup retries, stale-resource fencing and ambiguous-create reconciliation                                                      |

### Additional endpoint coverage

These rows make the less common callers explicit. Existing tests establish the
listed local contracts; they do not imply that an unexecuted live scenario passed.
Browser requests use the authenticated `ws-{workspaceId}` Worker route, whose VM
branch forwards to the shared node backend hostname and whose instant branch uses
the container DO. Callback requests travel from the agent to the API.

| Endpoint / caller                                                                                                                                                                                                                                                                                             | Existing verification                                                                                                                                                                                                                                                                                                                                                                                          | Live evidence or remaining gap                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot stream: browser `GET /boot-log/ws`; `index.ts` permits it while the workspace is creating. Boot callback: `POST /api/workspaces/:id/boot-log` → `services/boot-log.ts`.                                                                                                                                  | [boot-log service tests](../../apps/api/tests/unit/services/boot-log.test.ts), [callback authorization](../../apps/api/tests/unit/workspace-callback-auth-routing.test.ts), [workerd storage tests](../../apps/api/tests/workers/reliability-storage.test.ts). The [Go broadcaster tests](../../packages/vm-agent/internal/server/bootlog_ws_test.go) cover nil-safe behavior, not a live WebSocket handshake. | Ready/heartbeat and boot progress observed. **Pending:** authenticated boot-log WebSocket connection and frames during fresh provisioning.                                                                 |
| Worktrees: browser `GET/POST/DELETE /workspaces/:workspaceId/worktrees` from `apps/web/src/lib/api/files.ts` through the Worker to `server.go` worktree handlers.                                                                                                                                             | [Go worktree tests](../../packages/vm-agent/internal/server/worktrees_test.go) cover parsing, path validation and work-directory selection. They do not establish HTTP CRUD convergence.                                                                                                                                                                                                                       | **Pending:** list/create/remove a test worktree through the authenticated workspace route. Ordinary Git status/diff and push already passed.                                                               |
| Git credential refresh: private `GET /git-credential` → agent exchange → `POST /api/workspaces/:id/git-token`; helper access must remain private even when cloudflared connects over loopback.                                                                                                                | [Go credential handler tests](../../packages/vm-agent/internal/server/git_credential_test.go), [retry/auth failure tests](../../packages/vm-agent/internal/server/git_credential_retry_test.go), [API Git-token authorization tests](../../apps/api/tests/unit/routes/workspace-git-token.test.ts), and [tunnel listener isolation](../../packages/vm-agent/internal/server/tunnel_ingress_test.go).           | Real fixture clone/push and external helper denial passed. **Pending:** explicitly expire/invalidate a fixture's cached Git token and observe fresh exchange; do not revoke installation-wide credentials. |
| Workspace callback renewal: `POST /api/workspaces/:id/callback-token/renew`; restart/rebuild also send a fresh generation via `node-agent.ts`.                                                                                                                                                                | [Real workerd renewal tests](../../apps/api/tests/workers/workspace-callback-token-renewal.test.ts) cover aged/expired/wrong-workspace credentials, stopped hosts and instant refusal; [generation SQL tests](../../apps/api/tests/unit/routes/workspace-credential-generation-real-sql.test.ts) cover generation fencing.                                                                                     | Restart/rebuild and subsequent callbacks observed. No claim of waiting through the live token renewal age threshold; instant receives a fresh token on wake.                                               |
| MCP publication: `workspace-tools.ts` → `POST /workspaces/:id/mcp/build-and-publish`, or `/mcp/build-and-publish-jobs/:jobId/start` and `/cancel`; release callback `POST /api/projects/:id/compose-publish-release`. All use `getNodeBackendBaseUrl` + `fetchNodeAgent`; cancel preserves `noWakeContainer`. | [MCP build tests](../../apps/api/tests/unit/mcp-build-and-publish.test.ts), [real-SQL publication/cancellation fencing](../../apps/api/tests/unit/routes/publish-hardening-real-sqlite.test.ts), [bounded cancel failures](../../apps/api/tests/unit/services/deployment-publish-job-cancel.test.ts). These mock the build boundary and do not prove a tunnel-connected build.                                 | **Pending:** bounded build/publication transport or explicit failure-path exercise on the owned VM; no deployment to production.                                                                           |
| Prompt attachments: `POST /api/projects/:projectId/tasks/request-upload` → presigned R2 upload → session `/prompt` attachments → `transferWorkspaceAttachments` → `POST /workspaces/:id/files/upload`.                                                                                                        | [Upload route tests](../../apps/api/tests/unit/routes/attachment-upload.test.ts), [transfer payload/redaction tests](../../apps/api/tests/unit/services/workspace-attachments.test.ts), [real workerd shared-session attachment tests](../../apps/api/tests/workers/shared-session-attachments.test.ts) cover sender ownership, expiry and revocation during transfer.                                         | Direct file upload/download passed for VM and instant. **Pending:** actual prompt attachment through R2 and agent delivery; direct multipart upload alone does not prove that path.                        |
| MCP managed execution: `POST /workspaces/:id/mcp/secret-exec`, `GET /mcp/secret-exec/:jobId`, `POST /mcp/secret-exec/:jobId/cancel`, through `workspace-tools.ts` and runtime-aware forwarding.                                                                                                               | [MCP authorization tests](../../apps/api/tests/unit/routes/mcp-secret-exec.test.ts), [execution integration tests](../../apps/api/tests/integration/secret-exec.test.ts), and [Go handlers](../../packages/vm-agent/internal/server/mcp_secret_exec_test.go); normal start/status observed through the real fixture agent.                                                                                     | Harmless `secretNames: []` job completed on VM and instant. No live shared-secret rotation or cancellation of unrelated jobs.                                                                              |
| Account credential revocation during tunnel cleanup: Cloudflare API returns HTTP401 before owned DNS/tunnel deletion.                                                                                                                                                                                         | [Stateful cleanup regression](../../apps/api/tests/unit/services/node-tunnel-cleanup-edge.test.ts), test “retains owned resources and retryable journal when account credentials are revoked, then cleans after access is restored”: two due unauthorized sweeps preserve identity/resources and backoff; restored access deletes only owned resources, with no VM/A-record fallback.                          | Local boundary proof only; live account credentials are not revoked. Connector outage/recovery is a separate live fault scenario and is not claimed as connector-token revocation.                         |

## Local evidence so far

- Root lint, typecheck and build pass.
- Cloud-init: 245 tests pass, including executed firewall and deadline behavior.
- Preview upgrade regression: two real workerd tests pass for VM and instant.
- Installer OAuth catalog was queried read-only: cloudflared Write maps to
  `teams-connector-cloudflared.write`. Fresh full consent and preserve-mode upgrade
  tests pass (21 deployment tests).
- Full web suite: 402 files / 5056 assertions passed, but an unrelated toast timer
  fired after jsdom teardown and made the run fail. Its 11-test file passes alone.
  Tracked separately as SAM idea `01M729EEJXM1W9QBKFC9QJEVRN`; this is not a clean
  full-suite pass.
- Independent lifecycle review found resume cleanup, transport-switch metadata,
  and late Cloudflare-create cleanup gaps. Fixes and final re-review passed before the initial staging deployment.

## Known boundaries to distinguish during the live sweep

- Existing instant mode skips automatic port discovery; manual preview routing
  and WebSocket compatibility must be tested independently of discovery.
- Old direct-management and snapshot relay URLs use a nested VM hostname whose
  external TLS certificate failed the feasibility probe. Current Worker paths and
  new-agent direct R2 uploads avoid that legacy path. Follow-up idea:
  `01M729PB2EKNX0SKZ68WG53DN8`.
- General public TCP/UDP exposure is outside SAM's existing HTTP/WebSocket preview
  contract. Deployment-role nodes retain their current ingress behavior.

## Initial live results (09:47 UTC; final candidate pending)

- Fresh VM ready/heartbeat and exact agent release passed; D1 records tunnel transport and incarnation, and authoritative DNS contains only its proxied tunnel CNAME. Instant has no tunnel journal entry. The managed read-only debugging token cannot read tunnel details (401); this is an inventory-observation gap, not a tunnel failure.
- Real UI agents built and pushed the HTTP/WS fixture, exposed port 3000 through MCP, and completed a harmless managed-secret execution job. VM and instant HTML/assets/POST worked.
- VM terminal create/input/resize (31×97)/reattach, binary and text file transfer, file browser, Git status/diff, CLI HTTP forwarding, diagnostics/log WebSocket and five cross-user denials passed. Instant files, CLI, diagnostics, cross-user denials and private/public/private preview access passed.
- Two workspaces on one VM served different port-3000 markers across three alternating reads each.
- Primary rebuild returned202 and converged in26.65 seconds with its server healthy. Existing rebuild semantics reuse the container; a fresh fixture is needed to apply host-PID inspection settings.
- Instant streaming, text/binary WebSocket, requested subprotocol and35-second idle socket passed. Agent follow-up, accepted steering intent with eventual reply, cancellation, reconnect and snapshot sleep passed. Steering was not observed interrupting a foreground command. Subsequent wake verification confirmed exact preservation of nonignored uncommitted text/binary files and a restored port3000 health response; see private sanitized `instant-preservation-verify-evidence.json` and `instant-wake-confirmed-evidence.json`. The fixture's gitignored `.sam-e2e/` files were intentionally excluded. A numeric per-agent message-sequence check timed out across wake; independent message-ID/prompt-boundary verification confirmed the new reply.
- Live findings being fixed before final verification: SAM cookies reached preview applications; the Worker followed relative302 redirects against the agent path; instant PTY creation combined Setpgid and Setsid and failed with EPERM. Regression tests cover actual HTTP/WS auth boundaries and a real standalone PTY, including child-group shutdown.
- Host firewall/connector outage/reboot, final auth negatives, complete lifecycle restoration and owned-resource cleanup remain pending. No origin-IP requests have been made.
