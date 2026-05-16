export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function expectJsonRecord(value: unknown, context: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new Error(`Invalid payload at ${context}: expected object`);
  }
  return value;
}

export function maybeJsonRecord(value: unknown): JsonRecord | null {
  return isJsonRecord(value) ? value : null;
}

export function parseJsonRecord(raw: string, context: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(err instanceof Error ? `Invalid JSON at ${context}: ${err.message}` : `Invalid JSON at ${context}`);
  }
  return expectJsonRecord(parsed, context);
}

export function requireString(root: JsonRecord, key: string, context: string): string {
  const value = root[key];
  if (typeof value !== 'string') {
    throw new Error(`Invalid payload at ${context}.${key}: expected string`);
  }
  return value;
}

export async function readResponseJsonRecord(response: Response, context: string): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new Error(err instanceof Error ? `Invalid response JSON at ${context}: ${err.message}` : `Invalid response JSON at ${context}`);
  }
  return expectJsonRecord(parsed, context);
}
