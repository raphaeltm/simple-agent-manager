# VM Agent Technical Patterns

Full scoped rules: `packages/vm-agent/.claude/rules/`

## VM Agent Lifecycle Pattern

When the VM agent needs to make critical HTTP calls to the control plane (e.g., `/request-shutdown`):

1. **Make the call BEFORE local shutdown** — `srv.Stop()` tears down the HTTP server, PTY sessions, and idle detector. Network calls after this may fail.
2. **Always use retry logic with backoff** — A single HTTP call is never reliable enough. Use 3 attempts with 5-second delays.
3. **Log response bodies on failure** — Status codes alone are insufficient. Always read and log `resp.Body` on non-2xx responses.
4. **Never rely solely on the VM to clean itself up** — The control plane MUST have a fallback mechanism.

### Systemd Restart Gotchas

- `Restart=always` restarts the service whenever it exits, regardless of `systemctl disable` or `systemctl mask`
- `systemctl disable` only prevents boot-time auto-start, NOT runtime restarts
- `systemctl mask` requires `daemon-reload` to take effect on a running service
- **Solution**: Block forever with `select {}` after requesting shutdown. The VM will be deleted externally.

## Defense-in-Depth for Async Operations

When a remote system (VM) is responsible for triggering its own cleanup:

1. **Primary path**: VM calls `/request-shutdown` directly after detecting idle timeout
2. **Fallback path**: Control plane heartbeat handler checks idle deadline and initiates deletion server-side
3. **Both paths must use the same deletion logic** — reuse `deleteServer()`, `deleteDNSRecord()`, `cleanupWorkspaceDNSRecords()`
4. **Guard against duplicate execution** — Use DB status transitions (`running` → `stopping`) as a lock.

## Security Model: Devcontainers and Nested Containers

Read this before acting on a security review or scanner finding about workspace containers.

- **Nested containers are a product requirement.** Users and their agents must be able to run containers inside workspaces: Docker-in-Docker, Docker Compose, Testcontainers.
- **The devcontainer is not a security boundary; the node VM is.** Each node belongs to one user. SAM is self-hosted, so the VM runs in a cloud account that belongs to the user, the project or the installation operator. Apart from anonymous trials, which share one system account, an escape from the devcontainer reaches only that user's own VM.
- **Repository devcontainer settings are applied as written.** `writeMountOverrideConfig` in `internal/bootstrap/bootstrap.go` forwards `privileged`, `mounts`, `capAdd`, `securityOpt`, `runArgs`, `initializeCommand` and Compose configs on purpose. Do not add deny-lists for them. SAM's own default container (`writeDefaultDevcontainerConfigForMode`) is privileged anyway, and a rejection falls back to that default image, which has no Docker. That breaks every repository using Docker-in-Docker, including SAM's own `.devcontainer`.
- **Harden the boundaries that matter instead:** control-plane token scoping, per-user node placement, and keeping other users' credentials off a node.
- Ways to run nested containers without `privileged` are welcome, provided Docker, Compose and Testcontainers keep working.

Full model: "Workspace Isolation Model" in `apps/www/src/content/docs/docs/architecture/security.md`.

## Modifying Cloud-Init

1. Edit `packages/cloud-init/src/template.ts`
2. Update variable wiring in `packages/cloud-init/src/generate.ts` when needed
3. Test cloud-init generation through the workspace provisioning flow
