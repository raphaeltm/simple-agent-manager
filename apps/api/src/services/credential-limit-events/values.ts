import type { ProjectEventJsonValue, ProjectEventMetadata } from '@simple-agent-manager/shared';
import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';

import type { CredentialLimitStatus, CredentialSource } from './types';

const PRODUCER_LIMITS = DEFAULT_PROJECT_EVENT_LIMITS;
export const FILTER_STRING_MAX_BYTES = PRODUCER_LIMITS.maxFilterStringBytes;
export const TEXT_MAX_BYTES = PRODUCER_LIMITS.maxReasonBytes;
const METADATA_MAX_DEPTH = PRODUCER_LIMITS.maxMetadataDepth;
const METADATA_MAX_KEYS = PRODUCER_LIMITS.maxMetadataKeys;
const METADATA_ARRAY_MAX_ITEMS = PRODUCER_LIMITS.maxMetadataArrayItems;
export const DISPLAY_LABEL_MAX_COUNT = PRODUCER_LIMITS.maxDisplayLabels;
const TRUNCATION_SUFFIX = '...[truncated]';
export const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffixBytes = byteLength(TRUNCATION_SUFFIX);
  const payloadMax = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= payloadMax) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${value.slice(0, low)}${TRUNCATION_SUFFIX}`;
}

export function boundedIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return truncateUtf8(trimmed, FILTER_STRING_MAX_BYTES);
}

export function boundedText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncateUtf8(trimmed, TEXT_MAX_BYTES);
}

function normalizeJsonValue(
  value: ProjectEventJsonValue | undefined,
  depth = 0
): ProjectEventJsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return truncateUtf8(value, TEXT_MAX_BYTES);
  if (Array.isArray(value)) {
    if (depth >= METADATA_MAX_DEPTH) return [];
    return value
      .slice(0, METADATA_ARRAY_MAX_ITEMS)
      .map((item) => normalizeJsonValue(item, depth + 1))
      .filter((item): item is ProjectEventJsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    if (depth >= METADATA_MAX_DEPTH) return {};
    const normalized: ProjectEventMetadata = {};
    for (const [key, nestedValue] of Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, METADATA_MAX_KEYS)) {
      const normalizedValue = normalizeJsonValue(nestedValue, depth + 1);
      if (normalizedValue !== undefined) {
        const normalizedKey = boundedIdentifier(key);
        if (normalizedKey) normalized[normalizedKey] = normalizedValue;
      }
    }
    return normalized;
  }
  return undefined;
}

export function normalizeMetadata(
  input: Record<string, ProjectEventJsonValue | undefined>
): ProjectEventMetadata {
  const normalized: ProjectEventMetadata = {};
  for (const [key, value] of Object.entries(input).slice(0, METADATA_MAX_KEYS)) {
    const normalizedValue = normalizeJsonValue(value);
    const normalizedKey = boundedIdentifier(key);
    if (normalizedKey && normalizedValue !== undefined) {
      normalized[normalizedKey] = normalizedValue;
    }
  }
  return normalized;
}

export function stableSort(value: ProjectEventJsonValue): ProjectEventJsonValue {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, stableSort(nestedValue)])
    );
  }
  return value;
}

export function stableStringify(value: ProjectEventJsonValue): string {
  return JSON.stringify(stableSort(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function fingerprint(value: ProjectEventJsonValue): Promise<string> {
  return `sha256:${await sha256Hex(stableStringify(value))}`;
}

export function normalizeNumber(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function normalizeInteger(value: number | null | undefined): number | null {
  const normalized = normalizeNumber(value);
  return normalized === null ? null : Math.trunc(normalized);
}

export function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
  const normalized = normalizeInteger(value);
  if (normalized === null || normalized < 0) return null;
  return normalized;
}

export function normalizePercent(value: number | null | undefined): number | null {
  const normalized = normalizeNumber(value);
  if (normalized === null) return null;
  return Math.max(0, Math.min(100, normalized));
}

export function normalizeTimestamp(value: number | null | undefined): number | null {
  const normalized = normalizeInteger(value);
  if (normalized === null || normalized < 0) return null;
  return normalized;
}

export function normalizeCredentialSource(
  value: string | null | undefined
): CredentialSource | null {
  return value === 'user' || value === 'project' || value === 'platform' ? value : null;
}

export function normalizeStatus(value: string | null | undefined): CredentialLimitStatus {
  if (value === 'allowed' || value === 'allowed_warning' || value === 'rejected') return value;
  return 'unknown';
}

export function nullableNumberEquals(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < 0.000001;
}
