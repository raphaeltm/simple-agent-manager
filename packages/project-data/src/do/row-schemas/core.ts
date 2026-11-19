
// =============================================================================
// Generic parse helpers
// =============================================================================

export { mapRows, parseRow, parseRowOrNull } from '@simple-agent-manager/worker-core';

/** Safely parse a JSON string, returning null on failure. */
export function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
