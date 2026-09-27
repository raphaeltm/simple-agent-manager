# Codex shared-daemon/native-app integration spike

**Status:** DRAFT / EXPERIMENTAL — DO NOT MERGE OR ROLL OUT TO PRODUCTION
**SAM task:** `01M3G3E1KCR3WJWG2G1EGDF5E9`
**Idea:** `01M3G3CT3407BMRE72PQSCXT1A`
**Parent research:** `01M3G23F84KAEGYM2J91B8676M`

## Problem statement

SAM's pinned Codex ACP adapter owns a private stdio `codex app-server` child. The Codex native clients instead attach to a managed app-server daemon. The spike must let SAM and a second/native client control one canonical Codex thread while SAM continues to observe external turns and enforce transcript, activity, approval, cancellation, recovery, profile, MCP-principal, and workspace lifecycle invariants.

The default ACP path must remain unchanged. The experiment may activate only through an explicit per-session setting and must use a daemon isolated to the task workspace/user boundary. It must not attach to a host-global or unrelated user's daemon, publish an unauthenticated listener, expose pairing/auth material, or adopt native-created threads without SAM task/profile/principal attribution.

## Preflight and impact analysis

- Change classes: `external-api-change`, `cross-component-change`, `business-logic-change`, `security-sensitive-change`, and `infra-change` under `packages/vm-agent`.
- Primary path: browser ACP request -> `SessionHost` -> codex-acp -> Codex app-server -> ACP session updates -> SAM message/activity callbacks.
- Experimental path: the same SAM/codex-acp pipeline -> an explicit newline-JSON/WebSocket transport bridge -> a workspace-owned Codex app-server daemon; a second client attaches to that daemon and both clients operate on the same native thread.
- Multiplication factor: zero for default sessions; one daemon and one bridge per opted-in isolated Codex workspace. No shared-host singleton.
- Security boundary: the Unix control socket stays user-private; remote-control pairing uses the provider relay. Pairing codes, auth files, raw sensitive payloads, and approval contents must never enter logs, tests, or PR evidence.
- Lifecycle ownership: disconnecting codex-acp terminates only its bridge connection. It must not stop a daemon another authorized client uses. Workspace/container teardown remains the owner that terminates all workspace processes.
- Documentation: add a private operator spike guide/evidence matrix with exact versions, activation, pairing, cleanup, known limits, and an explicit non-production warning. Do not present pending native mobile/desktop validation as passed.
- Constitution: all opt-in names, socket locations, timeouts, limits, and feature behavior must be configurable or derived from the workspace/Codex home; no public listener or hardcoded tenant identity.

## Research findings

1. `packages/vm-agent/internal/acp/gateway.go` pins `@agentclientprotocol/codex-acp@1.13.1` and `@openai/codex@0.156.1`. The installed binaries match those versions.
2. Pinned codex-acp's `CodexJsonRpcConnection` always spawns `<CODEX_PATH> app-server` and uses newline-delimited JSON over stdio. It has no socket/daemon transport option. It keeps a thread event subscription after ACP prompt completion, so a shared connection can potentially surface external turns.
3. Codex 0.156.1 provides `app-server daemon`, `app-server proxy`, and `remote-control`. The daemon control socket is a WebSocket endpoint. `app-server proxy` is a raw byte tunnel carrying the HTTP WebSocket upgrade and WebSocket frames, not newline JSON. Directly substituting it through `CODEX_PATH` reproducibly hangs at initialization; this is the wrapper failure the implementation must avoid.
4. Official app-server protocol supports thread start/resume/read/list, turn start/steer/interrupt, streamed item events, server-initiated approvals, runtime thread status, and replayed thread history. The exact 0.156.1 protocol behavior is exercised against the installed CLI; codex-acp 1.13.1 remains the separately pinned adapter contract covered by repository tests rather than inferred from upstream main.
5. Official Remote documentation currently describes mobile pairing from a macOS/Windows desktop host and says setup cannot start from the CLI/IDE. agent-box demonstrates a headless daemon/pair-code flow, but that is not official proof of supported native discovery. Actual app verification remains a separate evidence row.
6. `SessionHost` already persists ACP session identity, serializes prompt ownership, deduplicates viewer replay, extracts normalized chat messages, and reports ACP tool-call activity. The spike should extend those authorities rather than create parallel transcript/idleness logic.
7. Relevant retained incident lessons require real-trigger protocol tests, unknown runtime state to fail closed for idleness, exact session identity through restart, secret-safe diagnostics, and a fresh staging VM for any vm-agent binary change.

Every finding is addressed by the checklist below; production UI/admission for native-created threads is explicitly deferred because this spike supports SAM-created, attributed threads only.

## Implementation checklist

- [x] Add one experimental configuration authority that validates opt-in, constrains an explicit socket to the configured workspace, and leaves the default ACP launch unchanged.
- [x] Add a small single-purpose newline-JSON/WebSocket bridge compatible with the pinned codex-acp launch contract; validate the appended `app-server` argument, WebSocket accept key, frame bounds, heartbeat, CLI version, and private socket target.
- [x] Attach only through a workspace-private relay supplied by the trusted runtime orchestrator; record the pinned CLI/server version in a restrictive marker and fail clearly on mismatch or daemon loss. The protocol cannot attest which upstream daemon that relay selects. Managed-daemon/native relay remains provider-limited as documented below.
- [x] Persist the canonical native thread identity as the existing Codex ACP session identity mapped to the SAM session/task, with an explicit attribution fence that rejects automatic adoption of unknown threads.
- [x] Normalize external user, assistant, tool, turn, approval, cancellation, and background-work events through existing SessionHost message/activity/lifecycle paths with stable-ID replay deduplication.
- [x] Fail shared-mode ACP approvals closed so SAM never approves on another attached client's behalf; native approval routing remains a live provider check.
- [x] Preserve profile model/effort/sandbox settings, SAM MCP servers, and verified SAM principal configuration by attaching external clients only to the exact thread created by the configured SAM ACP session.
- [x] Add deterministic tests for replay dedupe, activity leasing, attribution rejection, persistence authority, interruption, approval ownership, and default-path isolation.
- [x] Add a runnable isolated-home/workspace smoke harness against Codex 0.156.1, while repository tests cover the separately pinned codex-acp 1.13.1 adapter contract; redact sensitive values, own cleanup, and never copy or print auth state.
- [x] Run live raw-protocol two-client provider validation, including external item events and daemon process failure, plus deterministic SessionHost activity validation. Full runtime activity remains a staging check. Actual native pairing is pending authorized desktop/mobile access and is not inferred from the second protocol client.
- [x] Document evidence as deterministic protocol, live provider runtime, real desktop/mobile, and pending/failed rows; include cleanup and production recommendation/provider limitation.
- [x] Validate deterministic SessionHost suspend/resume against uncommitted files and native thread identity; live snapshot/relay re-enrollment remains a staging check.
- [x] Run Go race/static/coverage checks and repository lint/typecheck gates. Full Go tests/vet, focused race x10, repository lint/typecheck/test/build, format ratchet, file-size, type-boundary, and Gitleaks current-tree/PR-range checks pass.
- [x] Run task-completion, Go, security, constitution, docs-sync, and test-engineer reviews and address every blocking finding. The completion validator remains WARN only for the explicitly pending staging/native/provider evidence and will be rerun after staging.
- [ ] Coordinate a staging deployment, provision a fresh VM, verify heartbeat/workspace/shared-daemon behavior, and remove only resources created by this spike.
- [ ] Create a **draft** PR, keep `DRAFT / DO NOT MERGE` in task/PR state, wait for CI and CodeRabbit, and stop without merge or production rollout.

## Acceptance criteria

- One canonical Codex thread accepts turns from SAM and a second client; both see the same thread history and SAM records externally initiated user/assistant/tool events exactly once.
- Steering, cancellation, approval ownership, daemon failure, reconnect/replay, external activity, and completed-work lease release have executable proof.
- SAM task/chat -> native thread mapping survives adapter reconnect and session suspend/resume together with uncommitted workspace files.
- Native-origin turns retain the SAM-selected profile configuration and SAM MCP identity. Unknown/app-created threads are not adopted automatically.
- Existing non-opted-in Codex ACP behavior and all other agent types remain unchanged.
- No public unauthenticated listener, cross-tenant daemon, secret/pairing-code logging, or permanent always-awake workaround is introduced.
- The draft PR contains runnable code/tests/harness, exact versions, evidence matrix, cleanup instructions, and a candid production recommendation or precise provider limitation.

## Sources

- `packages/vm-agent/internal/acp/gateway.go`
- `packages/vm-agent/internal/acp/session_host.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- Pinned `/usr/local/share/npm-global/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js`
- https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexJsonRpcConnection.ts
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/remote-connections
- https://github.com/DefangDevs/agent-box
- https://github.com/openai/codex/issues/23572 (documents the proxy's raw WebSocket tunnel contract)

## Explicit deferrals

- Production UI for pairing/revocation, native-created-thread admission, cost/account ownership, cross-host relocation, and sustained relay soak testing require a follow-up SAM Idea after the spike result. They are not silently implemented or claimed here.

## Experimental activation and cleanup

The default path remains pinned `codex-acp` over its private stdio app-server. Shared mode activates only when the attributed Codex profile/runtime supplies `SAM_CODEX_SHARED_DAEMON=1` and `SAM_CODEX_SHARED_DAEMON_SOCKET` points to an already-running dedicated Unix relay inside the configured workspace. Codex 0.156.1 represents a requested listener as a symlink into `/tmp/codex-daemon-<uid>`; SAM therefore does not connect to that provider symlink directly. The owned harness places a raw byte relay at the configured workspace socket and forwards it to the provider listener. The configured socket, its canonical target, both parent directories, and the versioned `<socket>.sam-owner.json` marker must stay inside the workspace and be owned by the runtime UID with no group/other permissions. The marker records the relay socket's requested and canonical paths plus the server version. The bridge validator runs before both codex-acp and every native-observer connection/reconnect, and the observer also checks the initialized server user-agent version. This prevents direct discovery of a host-global socket, but the protocol cannot attest the relay upstream. The external orchestrator is a trusted boundary and must create the relay for the dedicated daemon it owns. Automatic `SAM_CODEX_SHARED_DAEMON_REMOTE_CONTROL=1` is rejected because SAM cannot yet prove ownership and restore relay state safely. The bridge owns client connections; it deliberately does not stop the separately owned daemon or relay when one client disconnects.

The supported experimental settings are:

| Setting                                        |    Default | Purpose                                                                                                                             |
| ---------------------------------------------- | ---------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SAM_CODEX_SHARED_DAEMON`                      |        off | Explicit opt-in; must equal a true flag value.                                                                                      |
| `SAM_CODEX_SHARED_DAEMON_SOCKET`               |   required | Absolute dedicated socket path inside the configured workspace.                                                                     |
| `SAM_CODEX_SHARED_DAEMON_CLI`                  |    `codex` | Pinned CLI executable used by the bridge and observer proxy.                                                                        |
| `SAM_CODEX_SHARED_DAEMON_HANDSHAKE_TIMEOUT_MS` |    `15000` | Bridge WebSocket upgrade deadline.                                                                                                  |
| `SAM_CODEX_SHARED_DAEMON_REQUEST_TIMEOUT_MS`   |    `30000` | Native observer JSON-RPC request deadline.                                                                                          |
| `SAM_CODEX_SHARED_DAEMON_WS_BUFFER_BYTES`      |     `4096` | Observer WebSocket read/write buffer size.                                                                                          |
| `SAM_CODEX_SHARED_DAEMON_RECONNECT_DELAY_MS`   |     `2000` | Delay between observer reconnect attempts.                                                                                          |
| `SAM_CODEX_SHARED_DAEMON_RECONNECT_TIMEOUT_MS` |    `30000` | Total observer recovery window before fail-closed process recovery.                                                                 |
| `SAM_CODEX_SHARED_DAEMON_MAX_FRAME_BYTES`      | `16777216` | Bridge and observer message bound.                                                                                                  |
| `SAM_CODEX_SHARED_DAEMON_PING_INTERVAL_MS`     |     `2000` | Bridge heartbeat interval.                                                                                                          |
| `SAM_CODEX_SHARED_DAEMON_PONG_TIMEOUT_MS`      |     `5000` | Bridge heartbeat failure deadline.                                                                                                  |
| `SAM_CODEX_SHARED_DAEMON_DEDUPE_LIMIT`         |     `4096` | In-memory replay accelerator; deterministic message IDs and the durable outbox unique key remain the full-history dedupe authority. |

SAM generates `CODEX_PATH`, `SAM_CODEX_SHARED_DAEMON_EXPECTED_VERSION`, and `SAM_CODEX_SHARED_DAEMON_SOCKET_OWNER_FILE`; profile/runtime configuration must not set them. `SAM_CODEX_SHARED_DAEMON_REMOTE_CONTROL` is deliberately rejected. Trusted host configuration can adjust the safety ceilings through `GatewayConfig.CodexSharedDaemonMaxDuration`, `CodexSharedDaemonMaxWebSocketBufferSize`, `CodexSharedDaemonMaxMessageBytes`, and `CodexSharedDaemonMaxDedupeLimit`; zero uses the conservative package defaults. Profiles can lower effective values but cannot exceed those host ceilings. The smoke-only timeout settings `SAM_CODEX_SHARED_DAEMON_SMOKE_TIMEOUT_MS`, `SAM_CODEX_SHARED_DAEMON_SMOKE_EXIT_TIMEOUT_MS`, `SAM_CODEX_SHARED_DAEMON_SMOKE_SOCKET_ATTEMPTS`, and `SAM_CODEX_SHARED_DAEMON_SMOKE_SOCKET_POLL_MS` default to `120000`, `10000`, `100`, and `50`. The smoke resolves its executable from `SAM_CODEX_SHARED_DAEMON_CLI` too.

Only the smoke harness currently owns listener startup, private relay startup, marker creation, restart, and cleanup as one runnable operation. Runtime activation outside that harness requires an orchestrator to start `codex app-server --listen unix://<provider-socket>` as the same runtime UID, place a private raw Unix byte relay at the configured workspace socket, and atomically write a mode-`0600` marker with `{"version":"0.156.1","socketPath":"<relay absolute path>","realSocketPath":"<same canonical relay path>"}`. The relay and both of its parent directories must be mode `0700`/`0600` as appropriate. That orchestrator must retain the exact daemon and relay process identities for cleanup. General daemon/relay supervision is intentionally not installed by this spike.

For the reproducible pinned test, use a dedicated test home containing an already-authorized test credential and run:

```bash
HOME=/path/to/isolated-home \
CODEX_HOME=/path/to/isolated-home/.codex \
SAM_CODEX_SHARED_DAEMON_SMOKE=1 \
node packages/vm-agent/scripts/codex-shared-daemon-smoke.mjs
```

The harness creates its workspace and private relay socket under a unique temporary directory, launches the installed 0.156.1 app-server directly, and deletes only those resources. It never copies credentials. For a manually launched direct listener, terminate only the recorded daemon and relay process groups, wait for both to exit, and then remove their sockets, owner marker, and isolated workspace. After a manual managed-daemon test, stop only the isolated test daemon with the same `HOME` and `CODEX_HOME`: `codex app-server daemon stop`. Remove the dedicated test home only after confirming no other session uses it.

Set `SAM_CODEX_SHARED_DAEMON_SMOKE_PREFLIGHT_ONLY=1` with a new empty isolated `CODEX_HOME` to validate the private relay, bridge endpoint checks, two simultaneous connections, and exact server version and daemon recovery without starting a model turn or reading an existing credential. This preflight is separate from the credentialed live evidence below.

The managed-daemon path currently has an exact-version limitation. On 2026-09-27, installed CLI 0.156.1 downloaded managed app-server 0.157.1. The bridge rejected that combination instead of silently validating newer server behavior. The live proof therefore used the 0.156.1 binary's direct private Unix listener. A production design needs a provider-supported way to pin the managed daemon package, or a compatibility contract between the pinned adapter/CLI and managed server.

## Evidence matrix

| Dimension                                   | Status                                        | Evidence / limitation                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing default ACP behavior               | PASS                                          | Feature flag defaults off; full `internal/acp` suite passes.                                                                                                                                                                                                                                                                                                                                                                    |
| Exact versions                              | PASS / provider limitation                    | codex-acp 1.13.1 and CLI/direct app-server 0.156.1 verified. Managed daemon self-installed 0.157.1 and was rejected.                                                                                                                                                                                                                                                                                                            |
| Hardened relay/bridge preflight             | PASS                                          | Two simultaneous clients connected through the workspace-private relay and validated the exact 0.156.1 server version and relay-preserving daemon recovery with a new empty Codex home; no credential or model turn was used.                                                                                                                                                                                                   |
| Raw app-server same-thread attachment       | PASS / hardened rerun pending                 | The credentialed live protocol smoke created one thread, resumed it from client two, and compared the exact ID before the final private-relay hardening. The relay transport preflight passes; a credentialed rerun through that relay is a staging check. This is not a native-app or full SessionHost result.                                                                                                                 |
| Raw app-server prompts from both clients    | PASS / hardened rerun pending                 | The earlier credentialed live smoke changed one uncommitted file from turns initiated by each client. The final private relay is protocol-transparent and preflighted, but model turns through it remain pending staging.                                                                                                                                                                                                       |
| SessionHost external event normalization    | DETERMINISTIC PASS / staging pending          | Observer tests normalize user, assistant, and tool items into stable durable message IDs and existing activity paths. The live two-client smoke observed all item categories but did not run SessionHost/codex-acp.                                                                                                                                                                                                             |
| Steering and cancellation                   | PASS / hardened rerun pending                 | The earlier credentialed live run kept the active turn ID through `turn/steer` and interrupted a running command from the other client. The hardened relay preflight covers connection recovery; credentialed steering/cancellation through it remains pending staging.                                                                                                                                                         |
| Approval ownership                          | PARTIAL / provider routing pending            | Observer has no response path, and shared-mode codex-acp fails every permission callback closed even during a SAM prompt. Actual native-origin request delivery and response ownership remain pending; no live approval was accepted or leaked.                                                                                                                                                                                 |
| Reconnect and replay dedupe                 | PASS by layer / hardened full runtime pending | The earlier credentialed protocol run disconnected, resumed, and read retained history before final relay hardening. The hardened credential-free preflight reconnects after daemon replacement. Deterministic observer tests cover atomic concurrent reservation, stable message IDs, and durable full-history dedupe beyond the bounded cache. A hardened credentialed SessionHost/codex-acp runtime remains pending staging. |
| Direct private-listener failure/recovery    | PASS / model-thread rerun pending             | The hardened credential-free preflight kills and replaces the direct 0.156.1 listener while preserving the private relay, then reconnects. The earlier credentialed run resumed the persisted thread before final relay hardening; that combined model-thread path remains pending staging. Managed daemon remains failed/pending because it installed 0.157.1.                                                                 |
| External activity tracking                  | DETERMINISTIC PASS / staging pending          | Tests assert native turn, approval, connection-loss, recovery, and exhaustion enter and leave the existing bounded activity authority. Live SessionHost reporting remains pending.                                                                                                                                                                                                                                              |
| Task/chat/native identity mapping           | PASS                                          | Observer starts only after ACP persists the native session ID and rejects a mismatched `thread/read` identity.                                                                                                                                                                                                                                                                                                                  |
| Profile and SAM MCP identity                | PASS by construction / staging pending        | Native turns attach to the exact SAM-created thread, whose model/settings/MCP configuration was established by the existing ACP NewSession/LoadSession path. End-to-end staging identity check remains pending.                                                                                                                                                                                                                 |
| Suspend/resume with uncommitted files       | PARTIAL / hardened full runtime pending       | The earlier credentialed daemon/client teardown preserved thread identity and uncommitted files before final relay hardening. Deterministic SessionHost tests preserve both across suspend/resume. A hardened live SAM snapshot sleep/wake remains pending staging.                                                                                                                                                             |
| Native desktop/mobile discovery and pairing | PENDING                                       | No authorized native test account/app was available. A second protocol client is explicitly not counted as native proof.                                                                                                                                                                                                                                                                                                        |
| Staging runtime                             | PENDING                                       | Requires coordinated fresh-VM deployment after review; no production rollout is authorized.                                                                                                                                                                                                                                                                                                                                     |

## Private native pairing check (pending)

Use a dedicated desktop host/test account and an isolated Codex home that contains no unrelated threads. Confirm the installed CLI and managed app-server versions first; do not proceed when they differ from the compatibility target. Start remote control with `codex remote-control start`; obtain a short-lived code with `codex remote-control pair` only at the moment the native app asks for it. Enter the code directly in the signed-in native app's remote-environment flow. Do not paste the code into logs, chat, the task, or the PR. Verify that the app lists the already-attributed SAM thread rather than creating/adopting another thread, run one turn from each surface, then revoke/stop the isolated host with `codex remote-control stop`. Record only pass/fail, client platform/version, thread-ID equality, and redacted timestamps. This is a separate manual compatibility check: the SAM spike never enables remote control on the runtime. Official documentation currently frames initial setup around a macOS/Windows desktop host, so agent-box's headless flow remains compatibility work rather than established native support.

## Production recommendation

Keep this implementation experimental. The clean production direction is an official codex-acp socket transport (or a SAM native app-server backend) plus a provider-supported managed-daemon version contract and authenticated native attribution metadata. Retain one SAM observer as the persistence/activity authority, exact-thread admission, stable native item IDs, and origin-client approval routing. Do not enable native-created-thread adoption until task, profile, principal, cost, and revocation ownership are explicit.
