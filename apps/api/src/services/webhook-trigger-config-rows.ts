/**
 * Mapping between `webhook_trigger_configs` rows and the configuration shapes the APIs accept
 * and return. Token hashes and the encrypted signing secret never leave this module's inputs.
 */
import {
  isWebhookSignedScheme,
  WEBHOOK_VERIFICATION_SCHEMES,
  type WebhookEventIdLocation,
  type WebhookTriggerConfig,
  type WebhookTriggerConfigInput,
  type WebhookTriggerFilter,
  type WebhookVerificationConfig,
  type WebhookVerificationScheme,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { buildTrustedApiUrl } from '../lib/trusted-origins';
import { StoredWebhookFiltersSchema } from '../schemas/triggers';
import { normalizeIncludedHeaders } from './webhook-trigger-payload';
import type { WebhookTokenMaterial } from './webhook-trigger-store';

export const WEBHOOK_BEARER_INGEST_PATH = '/api/webhooks/ingest';

/** Signed automations each have their own address; the ID in it is not a credential. */
export function signedWebhookIngestPath(triggerId: string): string {
  return `/api/webhooks/in/${encodeURIComponent(triggerId)}`;
}

/**
 * Stored conditions, or null when they cannot be read. An empty list would mean "no
 * conditions", which starts a run for every event, so unreadable conditions must not become
 * one: callers that start runs refuse the call instead.
 */
function parseFilters(row: schema.WebhookTriggerConfigRow): WebhookTriggerFilter[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.filtersJson);
  } catch {
    parsed = undefined;
  }
  const result = v.safeParse(StoredWebhookFiltersSchema, parsed);
  if (result.success) return result.output;
  log.warn('webhook_trigger.stored_filters_unreadable', {
    triggerId: row.triggerId,
    reason: parsed === undefined ? 'invalid_json' : 'invalid_shape',
  });
  return null;
}

function parseHeaders(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? normalizeIncludedHeaders(parsed)
      : [];
  } catch {
    return [];
  }
}

/** An unrecognized stored scheme is treated as the bearer scheme, which no signed route serves. */
export function webhookRowScheme(
  row: Pick<schema.WebhookTriggerConfigRow, 'verificationScheme'>
): WebhookVerificationScheme {
  return (WEBHOOK_VERIFICATION_SCHEMES as readonly string[]).includes(row.verificationScheme)
    ? (row.verificationScheme as WebhookVerificationScheme)
    : 'sam_bearer';
}

function rowVerification(row: schema.WebhookTriggerConfigRow): WebhookVerificationConfig {
  const scheme = webhookRowScheme(row);
  if (scheme === 'hmac_sha256_body') return { scheme, header: row.signatureHeader ?? '' };
  return { scheme };
}

export function webhookRowEventId(
  row: Pick<schema.WebhookTriggerConfigRow, 'eventIdSource' | 'eventIdKey'>
): WebhookEventIdLocation | null {
  if (!row.eventIdKey) return null;
  if (row.eventIdSource === 'header') return { header: row.eventIdKey };
  if (row.eventIdSource === 'path') return { path: row.eventIdKey };
  return null;
}

/**
 * What handling a call needs. Unlike the API shape it builds no URL, so it needs no domain.
 * `filters` is null when the stored conditions cannot be read; no run may start then.
 */
export type WebhookRuntimeConfig = Pick<
  WebhookTriggerConfig,
  'sourceLabel' | 'filterMode' | 'includedHeaders'
> & { filters: WebhookTriggerFilter[] | null };

export function toWebhookRuntimeConfig(row: schema.WebhookTriggerConfigRow): WebhookRuntimeConfig {
  return {
    sourceLabel: row.sourceLabel,
    filterMode: row.filterMode === 'any' ? 'any' : 'all',
    filters: parseFilters(row),
    includedHeaders: parseHeaders(row.includedHeadersJson),
  };
}

export function toWebhookTriggerConfig(
  row: schema.WebhookTriggerConfigRow,
  env: Pick<Env, 'BASE_DOMAIN'>
): WebhookTriggerConfig {
  const signed = isWebhookSignedScheme(webhookRowScheme(row));
  const runtime = toWebhookRuntimeConfig(row);
  return {
    ...runtime,
    // Settings still render with unreadable conditions (logged above); calls are refused until
    // the conditions are saved again.
    filters: runtime.filters ?? [],
    verification: rowVerification(row),
    eventId: webhookRowEventId(row),
    endpointUrl: buildTrustedApiUrl(
      env,
      signed ? signedWebhookIngestPath(row.triggerId) : WEBHOOK_BEARER_INGEST_PATH
    ),
    // A signed automation's token exists only to satisfy the column; it was never shown.
    tokenLastFour: signed ? null : row.tokenLastFour,
    tokenCreatedAt: signed ? null : row.tokenCreatedAt,
    tokenRotatedAt: signed ? null : row.tokenRotatedAt,
    signingSecret: signed
      ? {
          set: Boolean(row.signingSecretEncrypted && row.signingSecretIv),
          setAt: row.signingSecretSetAt,
          setBy: row.signingSecretSetBy,
        }
      : null,
  };
}

/**
 * The stored configuration with a patch applied. The verification scheme is fixed at creation,
 * so it always comes from the stored row; callers reject a patch that names a different one.
 */
export function mergeWebhookConfig(
  current: WebhookTriggerConfig,
  patch: WebhookTriggerConfigInput
): WebhookTriggerConfigInput {
  return {
    sourceLabel:
      patch.sourceLabel === undefined ? (current.sourceLabel ?? undefined) : patch.sourceLabel,
    filterMode: patch.filterMode ?? current.filterMode,
    filters: patch.filters ?? current.filters,
    includedHeaders: patch.includedHeaders ?? current.includedHeaders,
    verification: current.verification,
    eventId: patch.eventId ?? current.eventId ?? undefined,
  };
}

function eventIdColumns(eventId: WebhookEventIdLocation | undefined) {
  if (!eventId) return { eventIdSource: null, eventIdKey: null };
  return 'header' in eventId
    ? { eventIdSource: 'header', eventIdKey: eventId.header }
    : { eventIdSource: 'path', eventIdKey: eventId.path };
}

export function webhookConfigValues(
  triggerId: string,
  config: WebhookTriggerConfigInput,
  token: WebhookTokenMaterial
): schema.NewWebhookTriggerConfigRow {
  const verification = config.verification ?? { scheme: 'sam_bearer' };
  return {
    triggerId,
    tokenHash: token.tokenHash,
    tokenLastFour: token.tokenLastFour,
    tokenCreatedAt: token.createdAt,
    sourceLabel: config.sourceLabel?.trim() || null,
    filterMode: config.filterMode ?? 'all',
    filtersJson: JSON.stringify(config.filters ?? []),
    includedHeadersJson: JSON.stringify(normalizeIncludedHeaders(config.includedHeaders ?? [])),
    verificationScheme: verification.scheme,
    signatureHeader: verification.scheme === 'hmac_sha256_body' ? verification.header : null,
    ...eventIdColumns(config.eventId),
  };
}

export function webhookConfigUpdateValues(
  config: WebhookTriggerConfigInput,
  updatedAt: string
): Partial<schema.NewWebhookTriggerConfigRow> {
  return {
    sourceLabel: config.sourceLabel?.trim() || null,
    filterMode: config.filterMode ?? 'all',
    filtersJson: JSON.stringify(config.filters ?? []),
    includedHeadersJson: JSON.stringify(normalizeIncludedHeaders(config.includedHeaders ?? [])),
    ...eventIdColumns(config.eventId),
    updatedAt,
  };
}
