/**
 * Minimal, dependency-free runtime validation helpers shared across packages.
 *
 * This is the sanctioned home for the "is this a plain JSON object" check —
 * `packages/eslint-plugin-sam/src/rules/no-local-record-guard.js` flags ad hoc
 * local `isRecord`/`isObject` guard definitions matching this exact shape and
 * points consumers back here instead of letting every file redefine (and
 * drift on) the same check. Mirrors the predicate already used in
 * `apps/web/src/lib/runtime-validation.ts`.
 *
 * Deliberately scoped to a single predicate. Do not grow this file into a
 * general validation library — add new, purpose-specific helpers only when a
 * second real consumer needs them.
 */

/**
 * Runtime predicate for "is this a plain JSON-style object" — true for
 * non-null, non-array `object` values. Rejects arrays, `null`, and
 * primitives. Does not inspect keys or values.
 */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
