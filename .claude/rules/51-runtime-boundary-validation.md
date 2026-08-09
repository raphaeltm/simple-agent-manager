# Runtime boundary validation

External values stay `unknown` until a runtime boundary makes them safe.

Use the current Valibot helpers for API JSON and external service responses:

- `jsonValidator(schema)` in `apps/api/src/schemas/_validator.ts` for required Hono request bodies, followed by `c.req.valid('json')`.
- `parseOptionalBody(req, schema, fallback)` for optional request bodies where every schema field is optional.
- `parseWithSchema(schema, value, context)`, `expectJsonRecord`, `maybeJsonRecord`, `parseJsonRecord`, `readRequestJsonRecord`, and `readResponseJson` in `apps/api/src/lib/runtime-validation.ts` for non-Hono runtime JSON boundaries.

Sanctioned bounded patterns:

- Env access may use a narrow local env interface or a guard-then-cast when a Durable Object receives a structural subset/superset of the Worker env. Keep the cast local to the boundary and document why the fields exist.
- Durable Object stubs may use the existing typed RPC cast pattern after `env.<DO>.get(id)` or service-layer helpers, because Cloudflare's generated stub type cannot express the project-specific RPC surface.
- RPC/tool handlers may use a bounded handler cast at the registration boundary when the runtime dispatcher enforces the call shape elsewhere.
- Guard-then-cast is acceptable for small structural checks when schema parsing would be excessive: check object/null/array shape and required field types immediately before the cast.

Do not replace established bounded Zod subsystems incidentally. New API/runtime-validation work should prefer the Valibot helpers above unless the touched subsystem already has a contained Zod boundary.

Avoid these patterns in new code:

- `await c.req.json<T>()` without `jsonValidator` or an equivalent parser.
- `JSON.parse(raw) as T` except for `as unknown` followed by validation.
- Local `isRecord`/`isObject` helpers that recreate shared validation helpers.
- D1/Durable Object row arrays narrowed directly from `.toArray()`, `.first()`, `.all()`, or raw SQL results without a row mapper, schema parse, or guard.
- External webhook/fetch/request payloads narrowed directly to domain types without validation.
