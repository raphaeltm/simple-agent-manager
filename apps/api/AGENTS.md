# API Technical Patterns

Full rules: `.claude/rules/06-api-patterns.md`

## Error Handling

All API errors follow this format:

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

## Route Handler Pattern

```typescript
import * as v from 'valibot';
import { Hono } from 'hono';
import { jsonValidator } from '../schemas';

const MySchema = v.object({
  name: v.string(),
});

const routes = new Hono();

routes.post('/endpoint', jsonValidator(MySchema), async (c) => {
  const body = c.req.valid('json'); // typed & validated
  return c.json({ result: 'success' }, 201);
});
```

## Adding a New API Endpoint

1. Create route handler in `apps/api/src/routes/`
2. Register in `apps/api/src/index.ts`
3. Add integration tests
4. Update API contract in `specs/001-mvp/contracts/api.md`
