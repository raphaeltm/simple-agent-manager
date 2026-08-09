# sam/no-unsafe-json-parse-assertion

Flags TypeScript assertions that narrow the result of `JSON.parse(...)` directly to application shapes.

Allowed:

```ts
const parsed = JSON.parse(raw) as unknown;
```

Disallowed examples include `Record<string, unknown>`, `Partial<T>`, concrete object shapes, and nested typed assertions such as `JSON.parse(raw) as unknown as Payload`.

This rule is advisory and provides suggestions only. Runtime parsing/validation must be chosen by the owning code path.
