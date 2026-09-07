import type {
  AdmitProjectEventInput,
  ProjectEventJsonValue,
  ProjectEventMetadata,
  WebhookDeliveryOutcome,
  WebhookTriggerConfig,
} from '@simple-agent-manager/shared';
import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { enqueueAndAdmitProjectEventSourceIntent } from './project-event-source-outbox';

const WEBHOOK_EVENT_SOURCE = 'webhook';
const TRUNCATION_SUFFIX = '...[truncated]';
const SENSITIVE_KEY_RE =
  /(?:^|[_-])(authorization|cookie|token|secret|password|passwd|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session|set[_-]?cookie)(?:$|[_-])/i;

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
    if (byteLength(value.slice(0, mid)) <= payloadMax) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${value.slice(0, low)}${TRUNCATION_SUFFIX}`;
}

function boundedString(value: string, maxBytes = DEFAULT_PROJECT_EVENT_LIMITS.maxReasonBytes): string {
  return truncateUtf8(value.trim(), maxBytes);
}

function normalizeJsonValue(
  value: unknown,
  key: string | undefined,
  depth = 0
): ProjectEventJsonValue | undefined {
  if (key && SENSITIVE_KEY_RE.test(key)) return '[redacted]';
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return boundedString(value);
  if (Array.isArray(value)) {
    if (depth >= DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataDepth) return [];
    return value
      .slice(0, DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataArrayItems)
      .map((item) => normalizeJsonValue(item, undefined, depth + 1))
      .filter((item): item is ProjectEventJsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    if (depth >= DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataDepth) return {};
    const normalized: ProjectEventMetadata = {};
    for (const [childKey, childValue] of Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataKeys)) {
      const normalizedValue = normalizeJsonValue(childValue, childKey, depth + 1);
      if (normalizedValue !== undefined) {
        normalized[boundedString(childKey, DEFAULT_PROJECT_EVENT_LIMITS.maxFilterStringBytes)] =
          normalizedValue;
      }
    }
    return normalized;
  }
  return String(value);
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

export async function buildGenericWebhookProjectEventInput(
  input: GenericWebhookProjectEventInput
): Promise<AdmitProjectEventInput> {
  const eventType = `webhook.${input.outcome}`;
  const subject = { type: 'webhook_trigger', id: input.trigger.id };
  const metadata: ProjectEventMetadata = {
    provider: 'webhook',
    deliveryId: input.deliveryId,
    outcome: input.outcome,
    trigger: {
      id: input.trigger.id,
      name: boundedString(input.trigger.name),
      sourceLabel: input.config.sourceLabel ?? null,
    },
    project: {
      id: input.trigger.projectId,
      name: boundedString(input.projectName),
    },
    execution: {
      id: input.executionId ?? null,
      sequenceNumber: input.sequenceNumber ?? null,
    },
    headers: (normalizeJsonValue(input.headers, 'headers') ?? {}) as ProjectEventJsonValue,
    body: (normalizeJsonValue(input.body, 'body') ?? {}) as ProjectEventJsonValue,
  };
  return {
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
      summary: `Webhook trigger ${input.trigger.name} produced ${eventType}.`,
      labels: ['webhook', input.outcome],
    },
    rawPayloadRef: null,
    occurredAt: receivedAtMs(input.receivedAt),
    receivedAt: receivedAtMs(input.receivedAt),
  };
}

export async function enqueueGenericWebhookProjectEvent(env: Env, input: GenericWebhookProjectEventInput) {
  return enqueueAndAdmitProjectEventSourceIntent(
    env,
    await buildGenericWebhookProjectEventInput(input)
  );
}
