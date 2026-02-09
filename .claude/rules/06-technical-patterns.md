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
