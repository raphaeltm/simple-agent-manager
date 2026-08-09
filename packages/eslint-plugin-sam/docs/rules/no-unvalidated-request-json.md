# sam/no-unvalidated-request-json

Flags typed Hono-style `*.req.json<T>()` calls. The type argument is compile-time-only and does not validate request bodies at runtime.

Use route-level `jsonValidator(schema)` or an established parsing helper before consuming the request body.

This rule is advisory and provides suggestions only. It intentionally does not auto-fix because inserting validation changes route semantics and error behavior.
