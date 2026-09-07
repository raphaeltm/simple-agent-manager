import type {
  AdmitProjectEventInput,
  ProjectEventJsonValue,
  ProjectEventLimits,
  ProjectEventMetadata,
  WebhookDeliveryOutcome,
  WebhookTriggerConfig,
} from '@simple-agent-manager/shared';
import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import { resolveProjectEventLimits } from '../durable-objects/project-data/project-events-limits';
import { normalizeProjectEventInput } from '../durable-objects/project-data/project-events-normalization';
import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { enqueueAndAdmitProjectEventSourceIntent } from './project-event-source-outbox';

const WEBHOOK_EVENT_SOURCE = 'webhook';
const TRUNCATION_SUFFIX = '...[truncated]';
const METADATA_VARIANTS = ['full', 'compact', 'minimal', 'empty'] as const;
const SENSITIVE_COMPACT_KEY_PARTS = [
  'authorization',
  'authtoken',
  'apikey',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'password',
  'passphrase',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'secrets',
  'session',
  'sessionid',
  'skantapi',
  'setcookie',
  'token',
  'tokens',
];
type WebhookMetadataVariant = (typeof METADATA_VARIANTS)[number];
type BodyShapeFacts = {
  bodyTopLevelKeyCount: number;
  bodyObjectKeyCount: number;
  bodyArrayItemCount: number;
  bodyPrimitiveValueCount: number;
  bodyMaxDepth: number;
  redactedSensitiveKeyCount: number;
  skippedBlankKeyCount: number;
  shapeTruncated: boolean;
};

export interface GenericWebhookProjectEventInput {
  trigger: schema.TriggerRow;
  config: WebhookTriggerConfig;
  projectName: string;
  deliveryId: string;
  outcome: WebhookDeliveryOutcome;
  receivedAt: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  executionId?: string | null;
  sequenceNumber?: number | null;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffixBytes = byteLength(TRUNCATION_SUFFIX);
  const payloadMax = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= payloadMax) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, low)}${TRUNCATION_SUFFIX}`;
}

function boundedString(
  value: string,
  maxBytes = DEFAULT_PROJECT_EVENT_LIMITS.maxReasonBytes
): string {
  return truncateUtf8(value.trim(), maxBytes);
}

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(value: string): boolean {
  const compact = compactKey(value);
  return SENSITIVE_COMPACT_KEY_PARTS.some((part) => compact.includes(part));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function summarizeBodyShape(value: unknown, limits: ProjectEventLimits): BodyShapeFacts {
  const stats = {
    objectKeys: 0,
    arrayItems: 0,
    primitiveValues: 0,
    sensitiveKeys: 0,
    blankKeys: 0,
    maxDepth: 0,
    truncated: false,
  };
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visitBudget = Math.max(1, limits.maxMetadataKeys * limits.maxMetadataArrayItems);
  let visited = 0;

  while (stack.length > 0) {
    if (visited >= visitBudget) {
      stats.truncated = true;
      break;
    }
    visited += 1;
    const current = stack.pop();
    if (!current) break;
    stats.maxDepth = Math.max(stats.maxDepth, current.depth);
    if (Array.isArray(current.value)) {
      stats.arrayItems += current.value.length;
      for (const item of current.value.slice(0, limits.maxMetadataArrayItems)) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      if (current.value.length > limits.maxMetadataArrayItems) stats.truncated = true;
      continue;
    }
    if (isPlainObject(current.value)) {
      const entries = Object.entries(current.value);
      stats.objectKeys += entries.length;
      for (const [key, child] of entries.slice(0, limits.maxMetadataArrayItems)) {
        const trimmed = key.trim();
        if (!trimmed) stats.blankKeys += 1;
        if (trimmed && isSensitiveKey(trimmed)) stats.sensitiveKeys += 1;
        stack.push({ value: child, depth: current.depth + 1 });
      }
      if (entries.length > limits.maxMetadataArrayItems) stats.truncated = true;
      continue;
    }
    if (current.value !== undefined) stats.primitiveValues += 1;
  }

  return {
    bodyTopLevelKeyCount: isPlainObject(value) ? Object.keys(value).length : 0,
    bodyObjectKeyCount: stats.objectKeys,
    bodyArrayItemCount: stats.arrayItems,
    bodyPrimitiveValueCount: stats.primitiveValues,
    bodyMaxDepth: stats.maxDepth,
    redactedSensitiveKeyCount: stats.sensitiveKeys,
    skippedBlankKeyCount: stats.blankKeys,
    shapeTruncated: stats.truncated,
  };
}

function summarizeHeaderShape(input: GenericWebhookProjectEventInput): ProjectEventMetadata {
  return {
    includedHeaderCount: Object.keys(input.headers).length,
  };
}

function buildMetadata(
  input: GenericWebhookProjectEventInput,
  limits: ProjectEventLimits,
  variant: WebhookMetadataVariant
): ProjectEventMetadata {
  if (variant === 'empty') return {};
  const shape = summarizeBodyShape(input.body, limits);
  if (variant === 'minimal') {
    return {
      provider: 'webhook',
      outcome: input.outcome,
      request: {
        ...summarizeHeaderShape(input),
        bodyTopLevelKeyCount: shape.bodyTopLevelKeyCount,
        bodyObjectKeyCount: shape.bodyObjectKeyCount,
        bodyArrayItemCount: shape.bodyArrayItemCount,
        bodyPrimitiveValueCount: shape.bodyPrimitiveValueCount,
        bodyMaxDepth: shape.bodyMaxDepth,
        redactedSensitiveKeyCount: shape.redactedSensitiveKeyCount,
        skippedBlankKeyCount: shape.skippedBlankKeyCount,
        shapeTruncated: true,
      },
    };
  }
  if (variant === 'compact') {
    return {
      provider: 'webhook',
      deliveryId: boundedString(input.deliveryId, limits.maxFilterStringBytes),
      outcome: input.outcome,
      triggerId: boundedString(input.trigger.id, limits.maxFilterStringBytes),
      projectId: boundedString(input.trigger.projectId, limits.maxFilterStringBytes),
      executionId: input.executionId
        ? boundedString(input.executionId, limits.maxFilterStringBytes)
        : null,
      sequenceNumber: input.sequenceNumber ?? null,
      request: {
        ...summarizeHeaderShape(input),
        ...shape,
      },
    };
  }
  return {
    provider: 'webhook',
    deliveryId: boundedString(input.deliveryId, limits.maxFilterStringBytes),
    outcome: input.outcome,
    trigger: {
      id: boundedString(input.trigger.id, limits.maxFilterStringBytes),
      name: boundedString(input.trigger.name, limits.maxFilterStringBytes),
      sourceLabel: input.config.sourceLabel ?? null,
    },
    project: {
      id: boundedString(input.trigger.projectId, limits.maxFilterStringBytes),
      name: boundedString(input.projectName, limits.maxFilterStringBytes),
    },
    execution: {
      id: input.executionId
        ? boundedString(input.executionId, limits.maxFilterStringBytes)
        : null,
      sequenceNumber: input.sequenceNumber ?? null,
    },
    request: {
      ...summarizeHeaderShape(input),
      ...shape,
    },
  };
}

async function fingerprint(value: ProjectEventJsonValue): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(value)));
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function receivedAtMs(receivedAt: string): number | undefined {
  const parsed = Date.parse(receivedAt);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function projectEventLimits(env: Env): ProjectEventLimits {
  return resolveProjectEventLimits(
    env as unknown as Parameters<typeof resolveProjectEventLimits>[0]
  );
}

async function buildValidatedEventInput(
  env: Env,
  input: GenericWebhookProjectEventInput,
  variant: WebhookMetadataVariant
): Promise<AdmitProjectEventInput> {
  const limits = projectEventLimits(env);
  const eventType = `webhook.${input.outcome}`;
  const subject = { type: 'webhook_trigger', id: input.trigger.id };
  const metadata = buildMetadata(input, limits, variant);
  const eventInput: AdmitProjectEventInput = {
    projectId: input.trigger.projectId,
    source: WEBHOOK_EVENT_SOURCE,
    eventType,
    subject,
    severity: input.outcome === 'internal_error' ? 'error' : 'info',
    deliveryKey: `delivery:${input.deliveryId}`,
    payloadFingerprint: await fingerprint({
      source: WEBHOOK_EVENT_SOURCE,
      eventType,
      subject,
      metadata,
    }),
    metadata,
    display: {
      title: `Webhook ${input.outcome.replaceAll('_', ' ')}`,
      summary: `Webhook trigger ${boundedString(input.trigger.name)} produced ${eventType}.`,
      labels: ['webhook', input.outcome],
    },
    rawPayloadRef: null,
    occurredAt: receivedAtMs(input.receivedAt),
    receivedAt: receivedAtMs(input.receivedAt),
  };
  normalizeProjectEventInput(eventInput, limits);
  return eventInput;
}

export async function buildGenericWebhookProjectEventInput(
  input: GenericWebhookProjectEventInput,
  env?: Env
): Promise<AdmitProjectEventInput> {
  const eventEnv = env ?? ({} as Env);
  let lastError: unknown;
  for (const variant of METADATA_VARIANTS) {
    try {
      return await buildValidatedEventInput(eventEnv, input, variant);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Webhook event metadata is invalid');
}

export async function enqueueGenericWebhookProjectEvent(
  env: Env,
  input: GenericWebhookProjectEventInput
) {
  return enqueueAndAdmitProjectEventSourceIntent(
    env,
    await buildGenericWebhookProjectEventInput(input, env)
  );
}
