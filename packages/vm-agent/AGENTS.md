# VM Agent Technical Patterns

Rules that apply here are listed under "Rules for this directory" at the end of this file.

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
- **The devcontainer is not a security boundary; the node VM is.** Each node belongs to one user. SAM is self-hosted, so the VM runs in a cloud account that belongs to the user, the project or the installation operator. An escape from the devcontainer reaches only that user's own VM.
- **Repository devcontainer settings are applied as written.** `writeMountOverrideConfig` in `internal/bootstrap/bootstrap.go` forwards `privileged`, `mounts`, `capAdd`, `securityOpt`, `runArgs`, `initializeCommand` and Compose configs on purpose. Do not add deny-lists for them. SAM's own default container (`writeDefaultDevcontainerConfigForMode`) is privileged anyway, and a rejection falls back to that default image, which has no Docker. That breaks every repository using Docker-in-Docker, including SAM's own `.devcontainer`.
- **Harden the boundaries that matter instead:** control-plane token scoping, per-user node placement, and keeping other users' credentials off a node.
- Ways to run nested containers without `privileged` are welcome, provided Docker, Compose and Testcontainers keep working.

Full model: "Workspace Isolation Model" in `apps/www/src/content/docs/docs/architecture/security.md`.

## Modifying Cloud-Init

1. Edit `packages/cloud-init/src/template.ts`
2. Update variable types in `src/variables.ts`, validation in `src/validate.ts` and wiring in `src/generate.ts` when needed
3. Ingress-mode blocks (Origin CA direct mode, Cloudflare Tunnel mode) live in `src/template-ingress.ts` and render only for their mode; keep user-data under the 32 KB Hetzner limit
4. Test cloud-init generation through the workspace provisioning flow

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/06-vm-agent-patterns.md`: VM Agent Technical Patterns
- `.claude/rules/27-vm-agent-staging-refresh.md`: VM Agent Binary Refresh for Staging Tests
- `.claude/rules/34-vm-agent-callback-auth-agent-side.md`: VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE)
- `.claude/rules/34-vm-agent-callback-auth.md`: VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE)
- `.claude/rules/43-long-running-mcp-tools.md`: Long-Running MCP Tools Must Be Async
- `.claude/rules/46-vm-agent-diagnostic-getter-sync.md`: VM Agent Diagnostic Getters Must Synchronize Loop-Mutated Fields
- `.claude/rules/49-capture-prerequisites-before-async-completion.md`: Capture Handler Prerequisites Before a Long Async Operation
- `.claude/rules/51-vm-agent-no-host-mime-dependency.md`: VM Agent Behavior Must Not Depend on Host-Provided MIME/OS Databases
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`: Scheduled Handlers: Isolate Every Step, and Never Use a Liveness Timestamp as an Idleness Signal
- `.claude/rules/54-vm-agent-rollout-compatibility.md`: VM Agent Rollout Compatibility
- `.claude/rules/61-guards-must-cover-every-runtime.md`: A Guard Added for One Runtime Must Be Enforced for Every Runtime
- `.claude/rules/67-shared-predicates-that-trigger-actions.md`: Never Widen a Shared Predicate That Drives an Action
- `.claude/rules/71-request-context-must-not-outlive-its-request.md`: A Goroutine That Outlives Its Request Must Not Capture That Request's Context
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State
- `.claude/rules/75-external-api-check-then-act.md`: A Conflict From a Remote Uniqueness Constraint Is a Signal, Not a Failure
- `.claude/rules/78-snapshot-capture-must-scale-with-the-session.md`: Snapshot Capture Cost Must Scale With the Session, Not the Repository

<!-- END GENERATED RULE INDEX -->
