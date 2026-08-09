# sam/no-local-record-guard

Flags known local `isRecord` / `isObject` guard definitions that duplicate SAM runtime-validation helpers.

The matcher is intentionally narrow: it targets local definitions whose body is the familiar `typeof value === 'object' && value !== null` shape, with an optional `!Array.isArray(value)` clause and a TypeScript type-predicate return.

This rule is advisory and suggestion-only. Replacement requires call-site review because local guard semantics may intentionally differ.
