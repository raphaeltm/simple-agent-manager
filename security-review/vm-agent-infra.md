# Security Review: Domain C - VM Agent and Infrastructure Security

Date: 2026-06-25
Branch: `security-review/vm-agent-infra`
Scope: `packages/vm-agent/`, `packages/cloud-init/`, `packages/providers/`

## Domain Summary

This review covered VM agent HTTP/WebSocket routes, PTY and ACP process lifecycle, MCP-exposed workspace tools, file transfer routes, log export/streaming, callback/JWT validation, cloud-init generation, provider user-data handoff, TLS/Origin CA material, binary bootstrap trust, and multi-workspace/container isolation controls.

Mandatory SAM sub-reviewers were dispatched with profile `01KSWW2DQTZ8N3F2PYXKMJ7QZZ` under mission `c879abb0-770a-4187-8503-77dc1ba42ca8`, but all three failed before returning findings:

- `01KVZ8QEH9MD4JB4SGD1M2Z1AJ`: VM agent HTTP/WebSocket endpoint auth and injection sweep - failed
- `01KVZ8QM4NP4N1F353V7N5MSYJ`: cloud-init secret handling and provisioning trust - failed
- `01KVZ8QRPR4W0EQMSD72XZXV6H`: Go concurrency/process lifecycle/container isolation - failed

The findings below are therefore based on local read-only audit evidence.

## Severity Counts

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 3 |
| Medium | 4 |
| Low | 0 |

## Findings By Severity

### High

#### VM-001: Bootstrap installs unsigned VM agent binary

Severity: High
CWE: CWE-494 Download of Code Without Integrity Check
Location: `packages/cloud-init/src/template.ts:69`

Description: Cloud-init downloads `/usr/local/bin/vm-agent` from the control plane and immediately makes it executable without checking a pinned digest, detached signature, transparency log entry, or signed manifest. The API route registers binary artifact serving, but the bootstrap path does not require cloud-init to verify an expected hash before execution.

Impact/Exploit: If the control-plane download route, R2 object, DNS/TLS termination, or release bucket is compromised, a malicious root-running VM agent can be installed before JWT validation, callback authentication, deployment payload signatures, or later artifact hash checks are active.

Evidence: The template runs `curl -fLo /usr/local/bin/vm-agent "{{ control_plane_url }}/api/agent/download?arch=${ARCH}"` and then `chmod +x /usr/local/bin/vm-agent` at `packages/cloud-init/src/template.ts:69-70`. The route registration maps binaries via `registerBinaryArtifactRoutes` at `apps/api/src/routes/agent.ts:14-27`, but the cloud-init variables do not include an expected binary digest.

Remediation: Publish a signed release manifest containing per-OS/arch SHA-256 hashes. Embed the expected digest or a pinned public verification key in cloud-init, download the binary plus signature/manifest, verify before `chmod +x`, and fail closed on mismatch.

Confidence: High

#### VM-002: Callback token and Origin CA private key are persisted in cloud provider user-data

Severity: High
CWE: CWE-522 Insufficiently Protected Credentials
Location: `packages/cloud-init/src/template.ts:108`

Description: Cloud-init embeds the callback JWT and optional Origin CA private key directly into provider user-data and the generated VM filesystem. The systemd unit stores `CALLBACK_TOKEN` in a `0644` service file, and Origin CA material is written from the same user-data payload.

Impact/Exploit: Anyone who can read provider user-data, VM metadata, cloud-init logs, snapshots, or the root filesystem can recover the callback token and potentially the Origin CA private key. A leaked callback token lets an attacker impersonate the node/workspace to the control plane until expiry/rotation. A leaked Origin CA key can undermine Cloudflare-to-origin TLS identity for that node. Needs-verification: provider-specific metadata/user-data readback semantics and cloud-init log redaction were not exercised in a live VM.

Evidence: `CALLBACK_TOKEN={{ callback_token }}` is written into the vm-agent systemd unit at `packages/cloud-init/src/template.ts:108`; the Origin CA cert/key are written from template placeholders at `packages/cloud-init/src/template.ts:353-361`. The same generated `userData` is sent to Hetzner at `packages/providers/src/hetzner.ts:345`, Scaleway at `packages/providers/src/scaleway.ts:223-233`, and GCP metadata at `packages/providers/src/gcp.ts:415-420`.

Remediation: Replace long-lived secret embedding with a short-lived one-time bootstrap token. Have the agent redeem it over TLS for callback credentials and Origin CA material after boot, write secrets to root-only files outside provider user-data, rotate immediately after redemption, and avoid placing bearer tokens in world-readable unit files.

Confidence: Medium

#### VM-003: Terminal PTY cleanup can orphan child processes

Severity: High
CWE: CWE-404 Improper Resource Shutdown or Release
Location: `packages/vm-agent/internal/pty/session.go:253`

Description: Terminal sessions start either a host shell or `docker exec -it ... shell -l`, but `Close()` kills only the immediate `exec.Cmd` process and waits for it. It does not create a process group for terminal commands, signal the foreground process group, or terminate processes started inside the container.

Impact/Exploit: A user or compromised terminal session can start long-running child processes, disconnect/close the terminal, and leave those processes running. On shared nodes this can consume CPU/memory, retain access to injected credentials, continue network activity, or persist after the UI reports the terminal closed. ACP agent processes have more robust process-group/container `pkill` cleanup, but PTY terminal sessions do not.

Evidence: Container PTY sessions are spawned as `docker exec -it ...` at `packages/vm-agent/internal/pty/session.go:123-138`; host sessions use `exec.Command(shell)` at `packages/vm-agent/internal/pty/session.go:140-146`. Close only calls `s.Cmd.Process.Kill()` and `s.Cmd.Process.Wait()` at `packages/vm-agent/internal/pty/session.go:253-256`. In contrast, ACP process management documents process-group cleanup at `packages/vm-agent/internal/acp/process.go:165-167` and explicitly kills in-container processes at `packages/vm-agent/internal/acp/process.go:394-423`.

Remediation: Start PTY commands in a dedicated process group/session and close by signaling the process group. For container mode, track the exec session or run a scoped wrapper that can kill descendants inside the container. Add tests that spawn a child process and verify close/shutdown removes it.

Confidence: High

### Medium

#### VM-004: Boot-log and log-stream WebSockets bypass origin validation

Severity: Medium
CWE: CWE-346 Origin Validation Error
Location: `packages/vm-agent/internal/server/bootlog_ws.go:235`

Description: The standard terminal/ACP WebSocket upgrader validates `Origin` through `s.createUpgrader()`, but boot-log and log-stream handlers use custom upgraders with `CheckOrigin` returning `true`. Both handlers authenticate before upgrade, but cookie-backed WebSocket auth makes origin checks part of the browser-side CSRF/confidentiality boundary.

Impact/Exploit: If a browser sends a valid VM agent session cookie or a token-bearing URL is exposed to another origin, a malicious page can open these WebSockets and read boot/log output across origins. Logs can contain repository paths, provisioning details, command errors, and operational metadata.

Evidence: The shared upgrader validates origin at `packages/vm-agent/internal/server/websocket.go:16-27`. Boot-log WebSocket overrides this with `CheckOrigin: func(_ *http.Request) bool { return true }` at `packages/vm-agent/internal/server/bootlog_ws.go:235-239`. Log streaming does the same at `packages/vm-agent/internal/server/logs.go:68-73`.

Remediation: Use `s.createUpgrader()` for all browser-reachable WebSockets, or duplicate the same origin allow-list logic. Keep token-in-query support only where browser WebSocket limitations require it, and prefer short-lived, single-purpose tokens.

Confidence: High

#### VM-005: Node-level event and log auth allows any workspace session on the node

Severity: Medium
CWE: CWE-639 Authorization Bypass Through User-Controlled Key
Location: `packages/vm-agent/internal/server/events.go:99`

Description: Node-level `/events`, `/logs`, `/logs/stream`, `/containers`, `/events/export`, and `/metrics/export` use `requireNodeEventAuth()`. That helper accepts any non-empty workspace claim from a session cookie without checking that the session workspace still exists on the node, that the caller owns all workspaces represented in node-level logs, or that the endpoint should be scoped to one workspace.

Impact/Exploit: On a multi-workspace node, a user authenticated for one workspace can retrieve node-level events/logs/metrics containing other workspace IDs, container names, provisioning errors, and operational details. This weakens workspace isolation even if per-workspace routes are correctly scoped.

Evidence: Route registration exposes node-level logs/events/exports at `packages/vm-agent/internal/server/server.go:1006-1013`. `requireNodeEventAuth()` accepts any session with `session.Claims.Workspace != ""` at `packages/vm-agent/internal/server/events.go:99-103`, then the export handlers serve whole node databases at `packages/vm-agent/internal/server/events.go:123-173`.

Remediation: Require node-management tokens for node-wide endpoints, or return only records for the authenticated workspace when using workspace session auth. Check that the claimed workspace maps to an active runtime and avoid raw node database downloads for workspace-scoped callers.

Confidence: High

#### VM-006: JWKS endpoint is not constrained to HTTPS in VM agent configuration

Severity: Medium
CWE: CWE-295 Improper Certificate Validation
Location: `packages/vm-agent/internal/config/config.go:502`

Description: Cloud-init generation validates `controlPlaneUrl` and `jwksUrl` as HTTPS, but the Go VM agent itself accepts `CONTROL_PLANE_URL` and `JWKS_ENDPOINT` from environment and does not enforce an HTTPS scheme before creating the JWKS keyfunc.

Impact/Exploit: A misconfigured or attacker-controlled environment can point JWKS validation at plain HTTP or an unintended host, allowing token validation keys to be fetched over an unauthenticated channel. Needs-verification: production cloud-init appears to generate HTTPS URLs, so exploitability depends on deployment/config override paths.

Evidence: `Load()` derives `cfg.JWKSEndpoint = cfg.ControlPlaneURL + "/.well-known/jwks.json"` without URL scheme validation at `packages/vm-agent/internal/config/config.go:502-505`. `NewJWTValidator` passes the URL directly to `keyfunc.NewDefaultCtx` at `packages/vm-agent/internal/auth/jwt.go:39-45`.

Remediation: Parse `CONTROL_PLANE_URL` and `JWKS_ENDPOINT` in `cfg.Validate()`/`Load()` and reject non-HTTPS schemes outside explicit local-development mode. Log only the hostname/path, not sensitive query material.

Confidence: Medium

#### VM-007: Boot-log broadcaster performs WebSocket writes while holding the global broadcaster mutex

Severity: Medium
CWE: CWE-667 Improper Locking
Location: `packages/vm-agent/internal/server/bootlog_ws.go:62`

Description: Boot-log broadcasting holds `b.mu` while writing each log entry to every connected WebSocket. Adding a client also holds the same mutex while replaying all buffered history. Slow or stalled authenticated clients can therefore block new broadcasts, client registration/removal, and completion notification.

Impact/Exploit: An authenticated client can create a slow WebSocket reader and cause provisioning log fanout to stall. During bootstrap this can hide progress/failure signals from operators and accumulate blocked goroutines, reducing observability during the most sensitive provisioning window.

Evidence: `Broadcast()` locks `b.mu`, appends the entry, then loops over `b.clients` and calls `conn.WriteMessage` before unlocking at `packages/vm-agent/internal/server/bootlog_ws.go:62-82`. `AddClient()` also holds `b.mu` while sending buffered history at `packages/vm-agent/internal/server/bootlog_ws.go:91-115`.

Remediation: Copy the client list and buffered entries while holding the lock, release the lock, then perform network writes. Add write deadlines and remove slow clients asynchronously.

Confidence: High
