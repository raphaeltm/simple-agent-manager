# Technical Patterns

## Error Handling

All API errors should follow this format:

```typescript
{
  error: "error_code",
  message: "Human-readable description"
}
```

**CRITICAL: Hono Error Handler Pattern**

Use `app.onError()` for error handling — NEVER use middleware try/catch. Hono's `app.route()` subrouter errors do NOT propagate to parent middleware try/catch blocks, causing unhandled errors to return plain text "Internal Server Error".

```typescript
// CORRECT — catches errors from ALL routes including subrouters
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode);
  }
  return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
});

// WRONG — subrouter errors silently bypass this
app.use('*', async (c, next) => {
  try { await next(); } catch (err) { /* NEVER REACHED for subrouter errors */ }
});
```

Throw `AppError` (from `middleware/error.ts`) in route handlers — the global `app.onError()` handler catches them.

## Code Patterns

### Provider Implementation
```typescript
import { Provider, VMConfig, VMInstance } from './types';

export class MyProvider implements Provider {
  async createVM(config: VMConfig): Promise<VMInstance> {
    // Implementation
  }
}
```

### Hono Route Handler
```typescript
import { Hono } from 'hono';
import { errors } from '../middleware/error';

const routes = new Hono();

routes.post('/endpoint', async (c) => {
  const body = await c.req.json();
  if (!body.name) {
    throw errors.badRequest('Name is required'); // Caught by app.onError()
  }
  return c.json({ result: 'success' }, 201);
});
```

### React Component
```typescript
import { FC } from 'react';

interface Props {
  workspace: Workspace;
}

export const WorkspaceCard: FC<Props> = ({ workspace }) => {
  return (
    <div className="workspace-card">
      {/* Implementation */}
    </div>
  );
};
```

## VM Agent Lifecycle Pattern

When the VM agent needs to make critical HTTP calls to the control plane (e.g., `/request-shutdown`):

1. **Make the call BEFORE local shutdown** — `srv.Stop()` tears down the HTTP server, PTY sessions, and idle detector. Network calls after this may fail due to timeouts or connection issues.
2. **Always use retry logic with backoff** — A single HTTP call is never reliable enough for critical operations. Use 3 attempts with 5-second delays.
3. **Log response bodies on failure** — Status codes alone are insufficient for debugging. Always read and log `resp.Body` on non-2xx responses.
4. **Never rely solely on the VM to clean itself up** — The control plane MUST have a fallback mechanism (see below).

### Systemd Restart Gotchas

- `Restart=always` restarts the service whenever it exits, regardless of `systemctl disable` or `systemctl mask`
- `systemctl disable` only prevents boot-time auto-start, NOT runtime restarts
- `systemctl mask` requires `daemon-reload` to take effect on a running service
- **Solution**: Block forever with `select {}` after requesting shutdown. The VM will be deleted externally.

## Defense-in-Depth for Async Operations

When a remote system (VM) is responsible for triggering its own cleanup:

1. **Primary path**: VM calls `/request-shutdown` directly after detecting idle timeout
2. **Fallback path**: Control plane heartbeat handler checks if the VM reports being past the idle deadline and initiates deletion server-side
3. **Both paths must use the same deletion logic** — reuse `deleteServer()`, `deleteDNSRecord()`, `cleanupWorkspaceDNSRecords()`
4. **Guard against duplicate execution** — Use DB status transitions (`running` → `stopping`) as a lock. Only trigger deletion when status is `running`.

This pattern prevents runaway billing when VMs fail to self-delete due to network issues, auth errors, or bugs.

## Common Tasks

### Adding a New API Endpoint
1. Create route handler in `apps/api/src/routes/`
2. Register in `apps/api/src/index.ts`
3. Add integration tests
4. Update API contract in `specs/001-mvp/contracts/api.md`

### Adding a New Provider
1. Create provider class in `packages/providers/src/`
2. Implement `Provider` interface
3. Export from `packages/providers/src/index.ts`
4. Add unit tests

### Modifying Cloud-Init
1. Edit `packages/cloud-init/src/template.ts`
2. Update variable wiring in `packages/cloud-init/src/generate.ts` when needed
3. Test cloud-init generation through the workspace provisioning flow
