import type {
  WebhookFilterResult,
  WebhookTemplateContext,
  WebhookTriggerFilter,
} from '@simple-agent-manager/shared';

import { canonicalJson } from '../lib/canonical-json';

export { canonicalJson } from '../lib/canonical-json';

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-signature',
  'x-webhook-signature',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseWebhookJsonObject(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveWebhookPath(
  body: Record<string, unknown>,
  path: string,
  maxDepth: number
): unknown {
  const parts = path.split('.');
  if (
    parts.length === 0 ||
    parts.length > maxDepth ||
    parts.some((part) => !part || FORBIDDEN_PATH_SEGMENTS.has(part))
  ) {
    return undefined;
  }

  let current: unknown = body;
  for (const part of parts) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function valuesEqual(actual: unknown, expected: WebhookTriggerFilter['value']): boolean {
  return actual === expected;
}

function containsValue(actual: unknown, expected: WebhookTriggerFilter['value']): boolean {
  if (typeof actual === 'string') return actual.includes(String(expected ?? ''));
  if (Array.isArray(actual)) return actual.some((value) => valuesEqual(value, expected));
  return false;
}

export function evaluateWebhookFilters(
  body: Record<string, unknown>,
  filters: WebhookTriggerFilter[],
  mode: 'all' | 'any',
  maxDepth: number
): WebhookFilterResult {
  if (filters.length === 0) return { matched: true, matchedFilters: 0, totalFilters: 0 };

  const results = filters.map((filter) => {
    const actual = resolveWebhookPath(body, filter.path, maxDepth);
    if (filter.operator === 'exists') return actual !== undefined;
    if (filter.operator === 'equals') return valuesEqual(actual, filter.value);
    return containsValue(actual, filter.value);
  });
  const matchedFilters = results.filter(Boolean).length;
  const matched = mode === 'all' ? matchedFilters === filters.length : matchedFilters > 0;

  return {
    matched,
    matchedFilters,
    totalFilters: filters.length,
    reason: matched ? undefined : `${matchedFilters} of ${filters.length} filters matched`,
  };
}

export function normalizeIncludedHeaders(headers: string[]): string[] {
  return [...new Set(headers.map((header) => header.trim().toLowerCase()))].filter(
    (header) => header && !FORBIDDEN_HEADERS.has(header) && !header.includes('token')
  );
}

export function selectWebhookHeaders(
  requestHeaders: Headers | Record<string, string>,
  includedHeaders: string[]
): Record<string, string> {
  const normalized = normalizeIncludedHeaders(includedHeaders);
  return Object.fromEntries(
    normalized.flatMap((name) => {
      const value =
        requestHeaders instanceof Headers
          ? requestHeaders.get(name)
          : (requestHeaders[name] ?? requestHeaders[name.toLowerCase()]);
      return value === null || value === undefined ? [] : [[name, value]];
    })
  );
}

export interface BuildWebhookContextInput {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  receivedAt: string;
  deliveryId: string;
  sourceLabel: string | null;
  trigger: {
    id: string;
    name: string;
    description: string | null;
    triggerCount: number;
    projectId: string;
  };
  projectName: string;
  executionId: string;
  sequenceNumber: number;
}

export function buildWebhookContext(input: BuildWebhookContextInput): WebhookTemplateContext {
  return {
    webhook: {
      receivedAt: input.receivedAt,
      deliveryId: input.deliveryId,
      sourceLabel: input.sourceLabel ?? '',
      payload: canonicalJson(input.body),
      body: input.body,
      headers: input.headers,
    },
    trigger: {
      id: input.trigger.id,
      name: input.trigger.name,
      description: input.trigger.description ?? '',
      fireCount: String(input.trigger.triggerCount + 1),
    },
    project: { id: input.trigger.projectId, name: input.projectName },
    execution: { id: input.executionId, sequenceNumber: String(input.sequenceNumber) },
  };
}
