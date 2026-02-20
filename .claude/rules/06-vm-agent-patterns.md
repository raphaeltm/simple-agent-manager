---
paths:
  - "packages/vm-agent/**"
  - "scripts/vm/**"
---

# VM Agent Technical Patterns

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
4. **Guard against duplicate execution** — Use DB status transitions (`running` -> `stopping`) as a lock.

## Modifying Cloud-Init

1. Edit `packages/cloud-init/src/template.ts`
2. Update variable wiring in `packages/cloud-init/src/generate.ts` when needed
3. Test cloud-init generation through the workspace provisioning flow
