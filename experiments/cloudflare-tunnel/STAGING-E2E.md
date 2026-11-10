# Managed VM tunnel staging verification

Status: implementation and local review in progress; live compute sweep pending.
The earlier CI-loopback experiments are transport feasibility evidence, not this
managed VM end-to-end proof. No production tunnel cutover is authorized here.

## Fixture and transport assertions

- Parent task: `01M719ZRT6MJX696B9FH8TBWX9`.
- Staging only: `sammy.party`.
- Owned Artifact project: `01M728XDW1JB2T08YCF2XR39H7` (`Tunnel E2E 2026-11-10`).
- VM full profile: `01M728XGQ9FHXR3VPJ847VXD67`.
- Instant profile: `01M728XHBQ93TEGAEJCCT89K0K`.
- Candidate SHA, deployment run, sessions, workspace/node IDs: pending live sweep.
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

Every live row below is pending until its exact result is recorded.

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
  and late Cloudflare-create cleanup gaps. Fixes and final re-review pending.

## Known boundaries to distinguish during the live sweep

- Existing instant mode skips automatic port discovery; manual preview routing
  and WebSocket compatibility must be tested independently of discovery.
- Old direct-management and snapshot relay URLs use a nested VM hostname whose
  external TLS certificate failed the feasibility probe. Current Worker paths and
  new-agent direct R2 uploads avoid that legacy path. Follow-up idea:
  `01M729PB2EKNX0SKZ68WG53DN8`.
- General public TCP/UDP exposure is outside SAM's existing HTTP/WebSocket preview
  contract. Deployment-role nodes retain their current ingress behavior.
