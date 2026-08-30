import type { ProjectEventJsonValue, ProjectEventLimits } from '@simple-agent-manager/shared';

import {
  ProjectEventLimitExceededError,
  ProjectEventValidationError,
} from './project-events-contracts';

const TEXT_ENCODER = new TextEncoder();

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function byteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

export function normalizeText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new ProjectEventValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new ProjectEventValidationError(`${field} is required`);
  if (byteLength(normalized) > maxBytes) {
    throw new ProjectEventValidationError(`${field} must be ${maxBytes} bytes or fewer`);
  }
  return normalized;
}

export function normalizeNullableText(
  value: unknown,
  field: string,
  maxBytes: number
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeText(value, field, maxBytes);
}

export function normalizeOptionalText(
  value: unknown,
  field: string,
  maxBytes: number
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return normalizeText(value, field, maxBytes);
}

export function normalizeTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProjectEventValidationError(`${field} must be a non-negative integer timestamp`);
  }
  return value;
}

export function normalizeStringSet(
  values: unknown[],
  field: string,
  maxEntries: number,
  maxBytes: number
): string[] {
  if (values.length === 0) throw new ProjectEventValidationError(`${field} must not be empty`);
  if (values.length > maxEntries) {
    throw new ProjectEventLimitExceededError(
      `${field} must contain ${maxEntries} entries or fewer`
    );
  }
  return [
    ...new Set(values.map((item, index) => normalizeText(item, `${field}[${index}]`, maxBytes))),
  ].sort((a, b) => a.localeCompare(b));
}

export function normalizeJsonValue(
  input: unknown,
  limits: ProjectEventLimits,
  depth: number,
  stats: { keys: number },
  path: string
): ProjectEventJsonValue {
  if (depth > limits.maxMetadataDepth) {
    throw new ProjectEventLimitExceededError(`metadata depth exceeds ${limits.maxMetadataDepth}`);
  }
  if (
    input === null ||
    typeof input === 'string' ||
    typeof input === 'number' ||
    typeof input === 'boolean'
  ) {
    if (typeof input === 'number' && !Number.isFinite(input)) {
      throw new ProjectEventValidationError(`${path} must contain finite numbers`);
    }
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length > limits.maxMetadataArrayItems) {
      throw new ProjectEventLimitExceededError(
        `${path} must contain ${limits.maxMetadataArrayItems} array items or fewer`
      );
    }
    return input.map((item, index) =>
      normalizeJsonValue(item, limits, depth + 1, stats, `${path}[${index}]`)
    );
  }
  if (!isPlainObject(input)) {
    throw new ProjectEventValidationError(`${path} must be JSON-serializable`);
  }
  const output: Record<string, ProjectEventJsonValue> = {};
  for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
    stats.keys += 1;
    if (stats.keys > limits.maxMetadataKeys) {
      throw new ProjectEventLimitExceededError(
        `metadata must contain ${limits.maxMetadataKeys} keys or fewer`
      );
    }
    const normalizedKey = normalizeText(key, `${path}.key`, limits.maxFilterStringBytes);
    output[normalizedKey] = normalizeJsonValue(
      (input as Record<string, unknown>)[key],
      limits,
      depth + 1,
      stats,
      `${path}.${normalizedKey}`
    );
  }
  return output;
}

export function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => sortJson(item));
  if (!isPlainObject(input)) return input;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) output[key] = sortJson(value);
  }
  return output;
}

export function isPlainObject(input: unknown): input is Record<string, unknown> {
  return Object.prototype.toString.call(input) === '[object Object]';
}
