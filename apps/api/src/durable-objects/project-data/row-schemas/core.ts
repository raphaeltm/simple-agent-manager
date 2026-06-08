import * as v from 'valibot';

// =============================================================================
// Generic parse helpers
// =============================================================================

/**
 * Parse a single row with a Valibot schema; throw a descriptive error on failure.
 */
export function parseRow<TOutput>(
  schema: v.GenericSchema<unknown, TOutput>,
  row: unknown,
  context: string
): TOutput {
  const result = v.safeParse(schema, row);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => {
        const path = issue.path?.map((p) => p.key).join('.') || 'root';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Row validation failed (${context}): ${issues}`);
  }
  return result.output;
}

/** Safely parse a JSON string, returning null on failure. */
export function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
