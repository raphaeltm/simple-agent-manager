import {
  type CompactMessageOptions,
  DEFAULT_DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES,
  stripToolMetadataContent,
} from './row-schemas';
import type { Env } from './types';

export const DEFAULT_PROJECT_DATA_TOOL_METADATA_MAX_BYTES = 128 * 1024;

const textEncoder = new TextEncoder();
const MINIMAL_TOOL_METADATA_KEYS = [
  'toolCallId',
  'title',
  'kind',
  'status',
  'name',
  'tool',
  'exitCode',
  'contentSize',
] as const;

export function resolveCompactMessageOptions(env: Env): CompactMessageOptions {
  const parsed = Number.parseInt(env.DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES || '', 10);
  return {
    documentCardRawOutputMaxBytes:
      Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES,
  };
}

function resolveToolMetadataMaxBytes(env: Env): number {
  const parsed = Number.parseInt(env.PROJECT_DATA_TOOL_METADATA_MAX_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PROJECT_DATA_TOOL_METADATA_MAX_BYTES;
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isScalarJsonValue(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function buildMinimalToolMetadata(parsed: unknown, originalBytes: number): Record<string, unknown> {
  const minimal: Record<string, unknown> = {
    storageSafetyTruncated: true,
    contentTruncated: true,
    originalSizeBytes: originalBytes,
  };

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return minimal;
  }

  const record = parsed as Record<string, unknown>;
  for (const key of MINIMAL_TOOL_METADATA_KEYS) {
    const value = record[key];
    if (isScalarJsonValue(value)) minimal[key] = value;
  }

  if (Array.isArray(record.content)) {
    minimal.contentSize = utf8Bytes(JSON.stringify(record.content));
  }

  return minimal;
}

function serializeWithinLimit(value: unknown, maxBytes: number): string {
  let serialized = JSON.stringify(value);
  if (utf8Bytes(serialized) <= maxBytes) return serialized;

  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  serialized = JSON.stringify({
    storageSafetyTruncated: true,
    contentTruncated: true,
    originalSizeBytes: record.originalSizeBytes,
    toolCallId: isScalarJsonValue(record.toolCallId) ? record.toolCallId : undefined,
    title: isScalarJsonValue(record.title) ? record.title : undefined,
    kind: isScalarJsonValue(record.kind) ? record.kind : undefined,
    status: isScalarJsonValue(record.status) ? record.status : undefined,
    contentSize: isScalarJsonValue(record.contentSize) ? record.contentSize : undefined,
  });
  return utf8Bytes(serialized) <= maxBytes
    ? serialized
    : JSON.stringify({ storageSafetyTruncated: true });
}

export function boundToolMetadataForStorage(
  toolMetadata: string | null,
  env: Env
): {
  value: string | null;
  originalBytes: number;
  storedBytes: number;
  truncated: boolean;
} {
  if (toolMetadata === null) {
    return { value: null, originalBytes: 0, storedBytes: 0, truncated: false };
  }

  const maxBytes = resolveToolMetadataMaxBytes(env);
  const originalBytes = utf8Bytes(toolMetadata);
  if (originalBytes <= maxBytes) {
    return {
      value: toolMetadata,
      originalBytes,
      storedBytes: originalBytes,
      truncated: false,
    };
  }

  let bounded: string;
  try {
    const parsed = JSON.parse(toolMetadata);
    const compact = stripToolMetadataContent(parsed, resolveCompactMessageOptions(env));
    const compactJson = JSON.stringify(compact);
    bounded = utf8Bytes(compactJson) <= maxBytes
      ? compactJson
      : serializeWithinLimit(buildMinimalToolMetadata(parsed, originalBytes), maxBytes);
  } catch {
    bounded = serializeWithinLimit(
      {
        storageSafetyTruncated: true,
        contentTruncated: true,
        parseFailed: true,
        originalSizeBytes: originalBytes,
      },
      maxBytes
    );
  }

  return {
    value: bounded,
    originalBytes,
    storedBytes: utf8Bytes(bounded),
    truncated: true,
  };
}

export function stripToolMetadataPayloadForStorage(
  toolMetadata: string | null,
  env: Env
): {
  value: string | null;
  originalBytes: number;
  storedBytes: number;
  stripped: boolean;
  failed: boolean;
} {
  if (toolMetadata === null) {
    return { value: null, originalBytes: 0, storedBytes: 0, stripped: false, failed: false };
  }

  const originalBytes = utf8Bytes(toolMetadata);
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolMetadata);
  } catch {
    return {
      value: toolMetadata,
      originalBytes,
      storedBytes: originalBytes,
      stripped: false,
      failed: true,
    };
  }

  let compact: unknown;
  try {
    compact = stripToolMetadataContent(parsed, resolveCompactMessageOptions(env));
  } catch {
    return {
      value: toolMetadata,
      originalBytes,
      storedBytes: originalBytes,
      stripped: false,
      failed: true,
    };
  }
  const compactJson = JSON.stringify(compact);
  const compactBytes = utf8Bytes(compactJson);
  if (compactBytes >= originalBytes) {
    return {
      value: toolMetadata,
      originalBytes,
      storedBytes: originalBytes,
      stripped: false,
      failed: false,
    };
  }

  const maxBytes = resolveToolMetadataMaxBytes(env);
  const value = compactBytes <= maxBytes
    ? compactJson
    : serializeWithinLimit(buildMinimalToolMetadata(parsed, originalBytes), maxBytes);

  return {
    value,
    originalBytes,
    storedBytes: utf8Bytes(value),
    stripped: true,
    failed: false,
  };
}
