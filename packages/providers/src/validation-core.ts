import { ProviderError } from './types';

export type JsonObject = Record<string, unknown>;

export function expectObject(value: unknown, providerName: string, context: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(providerName, context, 'expected object');
  }
  return value as JsonObject;
}

export function requireObject(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): JsonObject {
  return expectObject(root[key], providerName, `${context}.${key}`);
}

export function optionalObject(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): JsonObject | undefined {
  const value = root[key];
  if (value === undefined || value === null) return undefined;
  return expectObject(value, providerName, `${context}.${key}`);
}

export function requireArray(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): unknown[] {
  const value = root[key];
  if (!Array.isArray(value)) {
    throw validationError(providerName, `${context}.${key}`, 'expected array');
  }
  return value;
}

export function optionalArray(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): unknown[] | undefined {
  const value = root[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw validationError(providerName, `${context}.${key}`, 'expected array');
  }
  return value;
}

export function requireString(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): string {
  const value = root[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(providerName, `${context}.${key}`, 'expected non-empty string');
  }
  return value;
}

export function optionalString(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): string | undefined {
  const value = root[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw validationError(providerName, `${context}.${key}`, 'expected string');
  }
  return value;
}

export function requireNumber(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): number {
  const value = root[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError(providerName, `${context}.${key}`, 'expected finite number');
  }
  return value;
}

export function optionalStringRecord(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): Record<string, string> | undefined {
  const record = optionalObject(root, key, providerName, context);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [entryKey, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      throw validationError(providerName, `${context}.${key}.${entryKey}`, 'expected string');
    }
    result[entryKey] = value;
  }
  return result;
}

export function validationError(
  providerName: string,
  context: string,
  expectation: string,
  cause?: unknown,
): ProviderError {
  return new ProviderError(
    providerName,
    undefined,
    `${providerName} API response validation failed at ${context}: ${expectation}`,
    { cause: cause instanceof Error ? cause : undefined },
  );
}
