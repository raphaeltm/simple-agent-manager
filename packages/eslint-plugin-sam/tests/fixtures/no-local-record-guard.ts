export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

export function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRecordWithSemantics(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

export function isRecordBoolean(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

export function isRecordAlias(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

const stringNearMiss = 'function isRecord(value: unknown): value is Record<string, unknown> {}';
// function isObject(value: unknown): value is object {}
