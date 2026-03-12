---
paths:
  - "apps/api/**"
---

# API Technical Patterns

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

## Hono Middleware Scoping (CRITICAL)

**NEVER use wildcard `use('/*', ...)` middleware on subrouters that share a base path with other subrouters using different auth models.** Hono's `app.route('/', subRouter)` merges routes — wildcard middleware from one subrouter leaks to ALL sibling subrouters mounted at the same path.

```typescript
// WRONG — middleware leaks to lifecycleRoutes and runtimeRoutes
const crudRoutes = new Hono();
crudRoutes.use('/*', requireAuth());  // catches ALL /api/workspaces/* requests
crudRoutes.get('/', handler);

const lifecycleRoutes = new Hono();
lifecycleRoutes.post('/:id/ready', callbackHandler);  // BLOCKED by crudRoutes middleware!

app.route('/', crudRoutes);
app.route('/', lifecycleRoutes);

// CORRECT — per-route middleware stays scoped
const crudRoutes = new Hono();
crudRoutes.get('/', requireAuth(), handler);  // only applies to this route

const lifecycleRoutes = new Hono();
lifecycleRoutes.post('/:id/ready', callbackHandler);  // not affected

app.route('/', crudRoutes);
app.route('/', lifecycleRoutes);
```

See `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md` for the production incident this caused.

**Auth routing tests must go through the combined routes app**, not individual subrouters. The middleware leak only manifests when subrouters are mounted together.

## Hono Route Handler Pattern

```typescript
import { Hono } from 'hono';
import { errors } from '../middleware/error';

const routes = new Hono();

routes.post('/endpoint', async (c) => {
  const body = await c.req.json();
  if (!body.name) {
    throw errors.badRequest('Name is required');
  }
  return c.json({ result: 'success' }, 201);
});
```

## Adding a New API Endpoint

1. Create route handler in `apps/api/src/routes/`
2. Register in `apps/api/src/index.ts`
3. Add integration tests
4. Update API contract in `specs/001-mvp/contracts/api.md`
