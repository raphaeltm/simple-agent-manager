# Runtime boundary validation

External values stay `unknown` until a runtime boundary makes them safe.

Use the current Valibot helpers for API JSON and external service responses:

- `jsonValidator(schema)` in `apps/api/src/schemas/_validator.ts` for required Hono request bodies, followed by `c.req.valid('json')`.
- `parseOptionalBody(req, schema, fallback)` for optional request bodies where every schema field is optional.
- `parseWithSchema(schema, value, context)`, `expectJsonRecord`, `maybeJsonRecord`, `parseJsonRecord`, `readRequestJsonRecord`, and `readResponseJson` in `apps/api/src/lib/runtime-validation.ts` for non-Hono runtime JSON boundaries.

## Valibot error messages must never carry secrets or cross-tenant data

Valibot's default issue messages interpolate the offending value (e.g. `Invalid type: Expected string but received "..."`), and `formatIssues`/`jsonValidator` (`apps/api/src/schemas/_validator.ts`) echo that text verbatim into the 400 response body. Only run `jsonValidator`/`formatIssues` against the immediate caller's own request body — never against another tenant's data, a decrypted secret, or server-computed state, since a validation failure would hand the value straight back in the response. For secret-adjacent parsing, use the non-throwing `maybeJsonRecord` plus sanitized logging instead — see `apps/api/src/durable-objects/codex-refresh-lock.ts` and `apps/api/src/services/composable-credentials/snapshot.ts` for the pattern.

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

## Sanctioned non-boundary casts

The report-only `record-string-unknown` / `unknown-double-assertion` populations in
`scripts/quality/type-boundary-baseline.json` are not a queue of unaddressed trust-boundary debt —
the current floor (measured 2026-08-11, ai-slop debt burn-down) is dominated by these three
sanctioned shapes, none of which narrow a value that crossed a trust boundary (D1/DO row, request
body, external fetch response):

- **CSS custom-property-as-number style casts** (e.g. `'var(--x)' as unknown as number` on a React
  `style` prop) — the value is a string literal the component itself authored, not external input;
  the cast exists only to satisfy `CSSProperties`' numeric typing for a property the browser accepts
  as a custom-property reference.
- **Third-party generic container / library type-gap casts** (React Flow's `NodeProps.data`,
  `BodyInit`/`BufferSource` DOM-lib gaps, MemoryFS shims) — the unsafe span is inside a third-party
  type definition that under- or over-constrains a shape SAM's own code already controls end to end,
  not a runtime value arriving from outside the process.
- **Self-constructed display/log payload widening** — building a human-readable diagnostic, log
  line, or UI display string from values the current function already validated or itself
  constructed is not re-parsing untrusted input; the cast only reconciles TypeScript's structural
  typing with a shape the author assembled.
