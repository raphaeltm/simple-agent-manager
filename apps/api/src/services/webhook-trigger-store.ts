import type {
  ListWebhookDeliveriesResponse,
  WebhookDeliveryOutcome,
  WebhookTriggerConfig,
  WebhookTriggerConfigInput,
  WebhookTriggerFilter,
} from '@simple-agent-manager/shared';
import { and, desc, eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import {
  generateWebhookToken,
  getWebhookTokenLastFour,
  hashWebhookToken,
} from './webhook-trigger-crypto';
import { getWebhookTriggerLimits } from './webhook-trigger-config';
import { normalizeIncludedHeaders } from './webhook-trigger-payload';

export interface WebhookTokenMaterial {
  token: string;
  tokenHash: string;
  tokenLastFour: string;
  createdAt: string;
}

export interface ResolvedWebhookTrigger {
  trigger: schema.TriggerRow;
  projectName: string;
  config: WebhookTriggerConfig;
}

function parseFilters(value: string): WebhookTriggerFilter[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as WebhookTriggerFilter[]) : [];
  } catch {
    return [];
  }
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

export function toWebhookTriggerConfig(row: schema.WebhookTriggerConfigRow): WebhookTriggerConfig {
  return {
    sourceLabel: row.sourceLabel,
    filterMode: row.filterMode === 'any' ? 'any' : 'all',
    filters: parseFilters(row.filtersJson),
    includedHeaders: parseHeaders(row.includedHeadersJson),
    tokenLastFour: row.tokenLastFour,
    tokenCreatedAt: row.tokenCreatedAt,
    tokenRotatedAt: row.tokenRotatedAt,
  };
}

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
  };
}

export async function createWebhookTokenMaterial(secret: string): Promise<WebhookTokenMaterial> {
  const token = generateWebhookToken();
  return {
    token,
    tokenHash: await hashWebhookToken(token, secret),
    tokenLastFour: getWebhookTokenLastFour(token),
    createdAt: new Date().toISOString(),
  };
}

export function webhookConfigValues(
  triggerId: string,
  config: WebhookTriggerConfigInput,
  token: WebhookTokenMaterial
): schema.NewWebhookTriggerConfigRow {
  return {
    triggerId,
    tokenHash: token.tokenHash,
    tokenLastFour: token.tokenLastFour,
    tokenCreatedAt: token.createdAt,
    sourceLabel: config.sourceLabel?.trim() || null,
    filterMode: config.filterMode ?? 'all',
    filtersJson: JSON.stringify(config.filters ?? []),
    includedHeadersJson: JSON.stringify(normalizeIncludedHeaders(config.includedHeaders ?? [])),
  };
}

export async function findWebhookTriggerByToken(
  env: Env,
  rawToken: string
): Promise<ResolvedWebhookTrigger | null> {
  const tokenHash = await hashWebhookToken(rawToken, env.ENCRYPTION_KEY);
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select({
      trigger: schema.triggers,
      projectName: schema.projects.name,
      config: schema.webhookTriggerConfigs,
    })
    .from(schema.webhookTriggerConfigs)
    .innerJoin(schema.triggers, eq(schema.webhookTriggerConfigs.triggerId, schema.triggers.id))
    .innerJoin(schema.projects, eq(schema.triggers.projectId, schema.projects.id))
    .where(eq(schema.webhookTriggerConfigs.tokenHash, tokenHash))
    .get();

  return row ? { ...row, config: toWebhookTriggerConfig(row.config) } : null;
}

export async function rotateWebhookToken(
  env: Env,
  projectId: string,
  triggerId: string
): Promise<WebhookTokenMaterial | null> {
  const token = await createWebhookTokenMaterial(env.ENCRYPTION_KEY);
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_trigger_configs
       SET token_hash = ?, token_last_four = ?, token_created_at = ?, token_rotated_at = ?, updated_at = ?
     WHERE trigger_id = ?
       AND EXISTS (SELECT 1 FROM triggers WHERE id = ? AND project_id = ? AND source_type = 'webhook')`
  )
    .bind(
      token.tokenHash,
      token.tokenLastFour,
      token.createdAt,
      token.createdAt,
      token.createdAt,
      triggerId,
      triggerId,
      projectId
    )
    .run();
  return result.meta.changes ? token : null;
}

export async function updateWebhookConfig(
  env: Env,
  projectId: string,
  triggerId: string,
  config: WebhookTriggerConfigInput
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_trigger_configs
       SET source_label = ?, filter_mode = ?, filters_json = ?,
           included_headers_json = ?, updated_at = ?
     WHERE trigger_id = ?
       AND EXISTS (SELECT 1 FROM triggers WHERE id = ? AND project_id = ? AND source_type = 'webhook')`
  )
    .bind(
      config.sourceLabel?.trim() || null,
      config.filterMode ?? 'all',
      JSON.stringify(config.filters ?? []),
      JSON.stringify(normalizeIncludedHeaders(config.includedHeaders ?? [])),
      now,
      triggerId,
      triggerId,
      projectId
    )
    .run();
  return Boolean(result.meta.changes);
}

export interface CreateWebhookDeliveryInput {
  triggerId: string;
  idempotencyKeyHash: string | null;
  requestFingerprint: string;
  bodyBytes: number;
  receivedAt: string;
}

export async function createWebhookDelivery(
  env: Env,
  input: CreateWebhookDeliveryInput
): Promise<{ id: string; created: boolean }> {
  const id = ulid();
  const expiresAt = new Date(
    new Date(input.receivedAt).getTime() +
      getWebhookTriggerLimits(env).deliveryRetentionDays * 86_400_000
  ).toISOString();
  const result = await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO webhook_deliveries
      (id, trigger_id, idempotency_key_hash, request_fingerprint, outcome, http_status,
       body_bytes, received_at, expires_at)
     VALUES (?, ?, ?, ?, 'internal_error', 503, ?, ?, ?)`
  )
    .bind(
      id,
      input.triggerId,
      input.idempotencyKeyHash,
      input.requestFingerprint,
      input.bodyBytes,
      input.receivedAt,
      expiresAt
    )
    .run();

  if (result.meta.changes) return { id, created: true };
  if (!input.idempotencyKeyHash) throw new Error('Webhook delivery persistence failed');

  const duplicate = await env.DATABASE.prepare(
    'SELECT id FROM webhook_deliveries WHERE trigger_id = ? AND idempotency_key_hash = ?'
  )
    .bind(input.triggerId, input.idempotencyKeyHash)
    .first<{ id: string }>();
  if (!duplicate) throw new Error('Webhook delivery deduplication failed');

  const duplicateId = ulid();
  const duplicateResult = await env.DATABASE.prepare(
    `INSERT INTO webhook_deliveries
      (id, trigger_id, idempotency_key_hash, request_fingerprint, outcome, http_status,
       body_bytes, received_at, processed_at, expires_at)
     VALUES (?, ?, NULL, ?, 'duplicate', 202, ?, ?, ?, ?)`
  )
    .bind(
      duplicateId,
      input.triggerId,
      input.requestFingerprint,
      input.bodyBytes,
      input.receivedAt,
      input.receivedAt,
      expiresAt
    )
    .run();
  if (!duplicateResult.meta.changes) throw new Error('Webhook duplicate audit persistence failed');
  return { id: duplicateId, created: false };
}

export async function finishWebhookDelivery(
  env: Env,
  input: {
    id: string;
    triggerId: string;
    outcome: WebhookDeliveryOutcome;
    httpStatus: number;
    executionId?: string | null;
    errorCode?: string | null;
  }
): Promise<void> {
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_deliveries
       SET outcome = ?, http_status = ?, execution_id = ?, error_code = ?, processed_at = ?
     WHERE id = ? AND trigger_id = ?`
  )
    .bind(
      input.outcome,
      input.httpStatus,
      input.executionId ?? null,
      input.errorCode ?? null,
      new Date().toISOString(),
      input.id,
      input.triggerId
    )
    .run();
  if (!result.meta.changes) throw new Error('Webhook delivery finalization failed');
}

export async function listWebhookDeliveries(
  env: Env,
  triggerId: string,
  cursor: string | undefined,
  limit: number
): Promise<ListWebhookDeliveriesResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const rows = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(
      cursor
        ? and(
            eq(schema.webhookDeliveries.triggerId, triggerId),
            lt(schema.webhookDeliveries.receivedAt, cursor)
          )
        : eq(schema.webhookDeliveries.triggerId, triggerId)
    )
    .orderBy(desc(schema.webhookDeliveries.receivedAt))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    deliveries: page.map((row) => ({
      id: row.id,
      triggerId: row.triggerId,
      outcome: row.outcome as WebhookDeliveryOutcome,
      httpStatus: row.httpStatus,
      bodyBytes: row.bodyBytes,
      executionId: row.executionId,
      errorCode: row.errorCode,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
    })),
    nextCursor: hasMore ? (page.at(-1)?.receivedAt ?? null) : null,
  };
}

export async function purgeExpiredWebhookDeliveries(env: Env): Promise<number> {
  const db = drizzle(env.DATABASE, { schema });
  const result = await db
    .delete(schema.webhookDeliveries)
    .where(lt(schema.webhookDeliveries.expiresAt, new Date().toISOString()));
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}
