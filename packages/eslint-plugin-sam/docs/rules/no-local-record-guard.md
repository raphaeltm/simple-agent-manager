# sam/no-local-record-guard

Flags known local `isRecord` / `isObject` guard definitions that duplicate SAM runtime-validation helpers.

The matcher is intentionally narrow: it targets local definitions whose body is the familiar `typeof value === 'object' && value !== null` shape, with an optional `!Array.isArray(value)` clause and a TypeScript type-predicate return.

This rule is `error` in production source and `off` in test files (idiomatic test-double typing is exempt) as of the 2026-08-11 ai-slop debt burn-down — see `rules.manifest.json` and `tasks/archive/2026-08-10-ai-slop-debt-burndown.md`. It is suggestion-only (no auto-fix); replacement requires call-site review because local guard semantics may intentionally differ.
