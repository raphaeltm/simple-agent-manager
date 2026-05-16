export type JsonRecord = Record<string, unknown>;

export function expectJsonRecord(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid payload at ${context}: expected object`);
  }
  return value as JsonRecord;
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

export function requireArray(root: JsonRecord, key: string, context: string): unknown[] {
  const value = root[key];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid payload at ${context}.${key}: expected array`);
  }
  return value;
}
