# sam/no-unvalidated-request-json

Flags typed Hono-style `*.req.json<T>()` calls. The type argument is compile-time-only and does not validate request bodies at runtime.

Use route-level `jsonValidator(schema)` or an established parsing helper before consuming the request body.

This rule is `error` in production source and `off` in test files (idiomatic test-double typing is exempt) as of the 2026-08-11 ai-slop debt burn-down — see `rules.manifest.json` and `tasks/archive/2026-08-10-ai-slop-debt-burndown.md`. It provides suggestions only and intentionally does not auto-fix because inserting validation changes route semantics and error behavior.
