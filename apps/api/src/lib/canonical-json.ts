import { maybeJsonRecord } from './runtime-validation';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  // Arrays are already handled above, so maybeJsonRecord's array-accepting
  // behavior (valibot's record schema treats numeric indices as string keys)
  // never applies here — only null/primitives are rejected (`null`) and plain
  // objects are accepted, matching the local isRecord guard this replaces.
  const record = maybeJsonRecord(value);
  if (!record) return value;

  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right, 'en-US'))
      .map((key) => [key, canonicalize(record[key])])
  );
}

/** Serialize JSON-compatible data with deterministic object-key ordering. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  return serialized ?? String(value);
}
