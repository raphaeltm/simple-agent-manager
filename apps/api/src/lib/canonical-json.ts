function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en-US'))
      .map((key) => [key, canonicalize(value[key])])
  );
}

/** Serialize JSON-compatible data with deterministic object-key ordering. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  return serialized ?? String(value);
}
