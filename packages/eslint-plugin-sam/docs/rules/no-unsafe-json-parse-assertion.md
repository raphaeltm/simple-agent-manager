# sam/no-unsafe-json-parse-assertion

Flags TypeScript assertions that narrow the result of `JSON.parse(...)` directly to application shapes.

Allowed:

```ts
const parsed = JSON.parse(raw) as unknown;
```

Disallowed examples include `Record<string, unknown>`, `Partial<T>`, concrete object shapes, and nested typed assertions such as `JSON.parse(raw) as unknown as Payload`.

This rule is `error` in production source and `off` in test files (idiomatic test-double typing is exempt) as of the 2026-08-11 ai-slop debt burn-down — see `rules.manifest.json` and `tasks/archive/2026-08-10-ai-slop-debt-burndown.md`. It provides suggestions only (no auto-fix). Runtime parsing/validation must be chosen by the owning code path.
