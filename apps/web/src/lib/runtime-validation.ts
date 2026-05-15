export type JsonRecord = Record<string, unknown>;

export class RuntimeValidationError extends Error {
  constructor(
    message: string,
    public readonly context: string
  ) {
    super(message);
    this.name = 'RuntimeValidationError';
  }
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function expectJsonRecord(value: unknown, context: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new RuntimeValidationError(`Invalid payload at ${context}: expected object`, context);
  }
  return value;
}

export function optionalJsonRecord(value: unknown, context: string): JsonRecord | undefined {
  if (value === undefined || value === null) return undefined;
  return expectJsonRecord(value, context);
}

export function parseJsonRecord(raw: string, context: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RuntimeValidationError(
      err instanceof Error ? `Invalid JSON at ${context}: ${err.message}` : `Invalid JSON at ${context}`,
      context
    );
  }
  return expectJsonRecord(parsed, context);
}

export async function readResponseJsonRecord(response: Response, context: string): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new RuntimeValidationError(
      err instanceof Error ? `Invalid response JSON at ${context}: ${err.message}` : `Invalid response JSON at ${context}`,
      context
    );
  }
  return expectJsonRecord(parsed, context);
}

export function requireString(root: JsonRecord, key: string, context: string): string {
  const value = root[key];
  if (typeof value !== 'string') {
    throw new RuntimeValidationError(`Invalid payload at ${context}.${key}: expected string`, context);
  }
  return value;
}
