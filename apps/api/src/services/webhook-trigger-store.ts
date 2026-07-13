import type {
  ListWebhookDeliveriesResponse,
  WebhookDeliveryOutcome,
  WebhookTriggerConfig,
  WebhookTriggerConfigInput,
  WebhookTriggerFilter,
} from '@simple-agent-manager/shared';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { getTaskRunnerStatus } from './task-runner-do';
import { getWebhookTriggerLimits } from './webhook-trigger-config';
import {
  generateWebhookToken,
  getWebhookTokenLastFour,
  hashWebhookToken,
} from './webhook-trigger-crypto';
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

export function webhookConfigUpdateValues(
  config: WebhookTriggerConfigInput,
  updatedAt: string
): Partial<schema.NewWebhookTriggerConfigRow> {
  return {
    sourceLabel: config.sourceLabel?.trim() || null,
    filterMode: config.filterMode ?? 'all',
    filtersJson: JSON.stringify(config.filters ?? []),
    includedHeadersJson: JSON.stringify(normalizeIncludedHeaders(config.includedHeaders ?? [])),
    updatedAt,
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

export interface CreateWebhookDeliveryInput {
  triggerId: string;
  idempotencyKeyHash: string | null;
  requestFingerprint: string;
  bodyBytes: number;
  receivedAt: string;
}

export type WebhookDeliveryReservation =
  | { disposition: 'reserved'; id: string; processingToken: string; retry: boolean }
  | { disposition: 'duplicate'; id: string; executionId?: string }
  | { disposition: 'in_flight'; id: string };

interface ProcessingDelivery {
  id: string;
  executionId: string | null;
  processingHeartbeatAt: string;
  processingToken: string;
  receivedAt: string;
}

interface LinkedWebhookTask {
  id: string;
  status: string;
}

async function reserveRetry(
  env: Env,
  input: CreateWebhookDeliveryInput,
  id: string,
  expiresAt: string,
  expectedOutcome: string,
  processingToken: string
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_deliveries
        SET outcome = 'processing', http_status = 0, body_bytes = ?, received_at = ?,
            processing_token = ?, processing_heartbeat_at = ?, processed_at = NULL,
            expires_at = ?, execution_id = NULL, error_code = NULL
      WHERE id = ? AND trigger_id = ? AND outcome = ? AND request_fingerprint = ?`
  )
    .bind(
      input.bodyBytes,
      input.receivedAt,
      processingToken,
      input.receivedAt,
      expiresAt,
      id,
      input.triggerId,
      expectedOutcome,
      input.requestFingerprint
    )
    .run();
  return Boolean(result.meta.changes);
}

async function reserveFailedLinkedTaskRetry(
  env: Env,
  input: CreateWebhookDeliveryInput,
  duplicate: ProcessingDelivery & { executionId: string },
  task: LinkedWebhookTask,
  expiresAt: string,
  processingToken: string
): Promise<boolean> {
  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE trigger_executions
          SET status = 'failed',
              error_message = COALESCE(error_message, 'Linked webhook task failed'),
              completed_at = COALESCE(completed_at, ?)
        WHERE id = ? AND trigger_id = ? AND status IN ('queued', 'running')`
    ).bind(input.receivedAt, duplicate.executionId, input.triggerId),
    env.DATABASE.prepare(
      `UPDATE webhook_deliveries
          SET outcome = 'processing', http_status = 0, body_bytes = ?, received_at = ?,
              processing_token = ?, processing_heartbeat_at = ?, processed_at = NULL,
              expires_at = ?, execution_id = NULL, error_code = NULL
        WHERE id = ? AND trigger_id = ? AND outcome = 'processing'
          AND request_fingerprint = ? AND processing_token = ?
          AND processing_heartbeat_at = ?
          AND EXISTS (
            SELECT 1 FROM tasks
             WHERE id = ? AND trigger_execution_id = ? AND status IN ('failed', 'cancelled')
          )`
    ).bind(
      input.bodyBytes,
      input.receivedAt,
      processingToken,
      input.receivedAt,
      expiresAt,
      duplicate.id,
      input.triggerId,
      input.requestFingerprint,
      duplicate.processingToken,
      duplicate.processingHeartbeatAt,
      task.id,
      duplicate.executionId
    ),
  ]);
  return Boolean(results.at(-1)?.meta.changes);
}

async function recoverStaleProcessingDelivery(
  env: Env,
  input: CreateWebhookDeliveryInput,
  duplicate: ProcessingDelivery,
  expiresAt: string,
  processingToken: string,
  linkedTask: LinkedWebhookTask | null = null
): Promise<boolean> {
  const cutoff = Date.now() - getWebhookTriggerLimits(env).deliveryProcessingLeaseSeconds * 1000;
  if (new Date(duplicate.processingHeartbeatAt).getTime() > cutoff) return false;

  const statements: D1PreparedStatement[] = [];
  if (duplicate.executionId && linkedTask) {
    statements.push(
      env.DATABASE.prepare(
        `UPDATE tasks
            SET status = 'failed', error_message = 'Webhook delivery processing lease expired',
                completed_at = ?, updated_at = ?
          WHERE id = ? AND trigger_execution_id = ? AND status IN ('draft', 'ready', 'queued')`
      ).bind(input.receivedAt, input.receivedAt, linkedTask.id, duplicate.executionId)
    );
  }
  if (duplicate.executionId) {
    statements.push(
      env.DATABASE.prepare(
        `UPDATE trigger_executions
            SET status = 'failed', error_message = 'Webhook delivery processing lease expired',
                completed_at = ?
          WHERE id = ? AND trigger_id = ? AND status = 'queued'
            ${linkedTask ? "AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND trigger_execution_id = ? AND status = 'failed')" : 'AND NOT EXISTS (SELECT 1 FROM tasks WHERE trigger_execution_id = ?)'} `
      ).bind(
        input.receivedAt,
        duplicate.executionId,
        input.triggerId,
        ...(linkedTask ? [linkedTask.id, duplicate.executionId] : [duplicate.executionId])
      )
    );
  }
  statements.push(
    env.DATABASE.prepare(
      `UPDATE webhook_deliveries
          SET body_bytes = ?, received_at = ?, expires_at = ?, execution_id = NULL,
              processing_token = ?, processing_heartbeat_at = ?, processed_at = NULL,
              http_status = 0, error_code = NULL
        WHERE id = ? AND trigger_id = ? AND outcome = 'processing'
          AND request_fingerprint = ? AND processing_token = ?
          AND processing_heartbeat_at = ?
          ${
            duplicate.executionId
              ? linkedTask
                ? "AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND trigger_execution_id = ? AND status = 'failed')"
                : 'AND NOT EXISTS (SELECT 1 FROM tasks WHERE trigger_execution_id = ?)'
              : ''
          }`
    ).bind(
      input.bodyBytes,
      input.receivedAt,
      expiresAt,
      processingToken,
      input.receivedAt,
      duplicate.id,
      input.triggerId,
      input.requestFingerprint,
      duplicate.processingToken,
      duplicate.processingHeartbeatAt,
      ...(duplicate.executionId
        ? linkedTask
          ? [linkedTask.id, duplicate.executionId]
          : [duplicate.executionId]
        : [])
    )
  );
  const results = await env.DATABASE.batch(statements);
  return Boolean(results.at(-1)?.meta.changes);
}

export async function createWebhookDelivery(
  env: Env,
  input: CreateWebhookDeliveryInput
): Promise<WebhookDeliveryReservation> {
  const id = ulid();
  const processingToken = ulid();
  const expiresAt = new Date(
    new Date(input.receivedAt).getTime() +
      getWebhookTriggerLimits(env).deliveryRetentionDays * 86_400_000
  ).toISOString();
  const result = await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO webhook_deliveries
      (id, trigger_id, idempotency_key_hash, request_fingerprint, outcome, http_status,
       body_bytes, processing_token, processing_heartbeat_at, received_at, expires_at)
     VALUES (?, ?, ?, ?, 'processing', 0, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.triggerId,
      input.idempotencyKeyHash,
      input.requestFingerprint,
      input.bodyBytes,
      processingToken,
      input.receivedAt,
      input.receivedAt,
      expiresAt
    )
    .run();

  if (result.meta.changes) {
    return { disposition: 'reserved', id, processingToken, retry: false };
  }
  if (!input.idempotencyKeyHash) throw new Error('Webhook delivery persistence failed');

  const duplicate = await env.DATABASE.prepare(
    `SELECT id, outcome, request_fingerprint,
            execution_id AS executionId, processing_token AS processingToken,
            processing_heartbeat_at AS processingHeartbeatAt, received_at AS receivedAt
       FROM webhook_deliveries
      WHERE trigger_id = ? AND idempotency_key_hash = ?`
  )
    .bind(input.triggerId, input.idempotencyKeyHash)
    .first<{
      id: string;
      outcome: string;
      request_fingerprint: string;
      executionId: string | null;
      processingToken: string | null;
      processingHeartbeatAt: string | null;
      receivedAt: string;
    }>();
  if (!duplicate) throw new Error('Webhook delivery deduplication failed');

  if (duplicate.request_fingerprint === input.requestFingerprint) {
    if (
      duplicate.outcome === 'internal_error' &&
      (await reserveRetry(env, input, duplicate.id, expiresAt, duplicate.outcome, processingToken))
    ) {
      return { disposition: 'reserved', id: duplicate.id, processingToken, retry: true };
    }
    if (duplicate.outcome === 'processing') {
      if (!duplicate.processingToken || !duplicate.processingHeartbeatAt) {
        throw new Error('Webhook processing lease is incomplete');
      }
      const processingDelivery: ProcessingDelivery = {
        ...duplicate,
        processingToken: duplicate.processingToken,
        processingHeartbeatAt: duplicate.processingHeartbeatAt,
      };
      let linkedTask: LinkedWebhookTask | null = null;
      if (duplicate.executionId) {
        linkedTask = await env.DATABASE.prepare(
          'SELECT id, status FROM tasks WHERE trigger_execution_id = ? LIMIT 1'
        )
          .bind(duplicate.executionId)
          .first<LinkedWebhookTask>();
        if (
          linkedTask &&
          (linkedTask.status === 'failed' || linkedTask.status === 'cancelled') &&
          (await reserveFailedLinkedTaskRetry(
            env,
            input,
            { ...processingDelivery, executionId: duplicate.executionId },
            linkedTask,
            expiresAt,
            processingToken
          ))
        ) {
          return { disposition: 'reserved', id: duplicate.id, processingToken, retry: true };
        }

        const taskRunnerStarted =
          linkedTask?.status === 'queued'
            ? Boolean(await getTaskRunnerStatus(env, linkedTask.id))
            : false;
        const taskAdvanced =
          linkedTask !== null &&
          ['delegated', 'in_progress', 'completed'].includes(linkedTask.status);
        if (linkedTask && (taskRunnerStarted || taskAdvanced)) {
          await finishWebhookDelivery(env, {
            id: duplicate.id,
            triggerId: input.triggerId,
            outcome: 'accepted',
            httpStatus: 202,
            executionId: duplicate.executionId,
            processingToken: duplicate.processingToken,
          });
          return {
            disposition: 'duplicate',
            id: duplicate.id,
            executionId: duplicate.executionId,
          };
        }
      }
      if (
        await recoverStaleProcessingDelivery(
          env,
          input,
          processingDelivery,
          expiresAt,
          processingToken,
          linkedTask
        )
      ) {
        return { disposition: 'reserved', id: duplicate.id, processingToken, retry: true };
      }
      return { disposition: 'in_flight', id: duplicate.id };
    }
  }

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
  return { disposition: 'duplicate', id: duplicateId };
}

export async function finishWebhookDelivery(
  env: Env,
  input: {
    id: string;
    triggerId: string;
    outcome: WebhookDeliveryOutcome;
    httpStatus: number;
    processingToken: string;
    executionId?: string | null;
    errorCode?: string | null;
  }
): Promise<void> {
  const finalized = await tryFinishWebhookDelivery(env, input);
  if (!finalized) throw new Error('Webhook delivery finalization failed');
}

async function tryFinishWebhookDelivery(
  env: Env,
  input: {
    id: string;
    triggerId: string;
    outcome: WebhookDeliveryOutcome;
    httpStatus: number;
    processingToken: string;
    executionId?: string | null;
    errorCode?: string | null;
  }
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_deliveries
       SET outcome = ?, http_status = ?, execution_id = COALESCE(?, execution_id),
           error_code = ?, processed_at = ?, processing_token = NULL,
           processing_heartbeat_at = NULL
     WHERE id = ? AND trigger_id = ? AND outcome = 'processing' AND processing_token = ?`
  )
    .bind(
      input.outcome,
      input.httpStatus,
      input.executionId ?? null,
      input.errorCode ?? null,
      new Date().toISOString(),
      input.id,
      input.triggerId,
      input.processingToken
    )
    .run();
  return Boolean(result.meta.changes);
}

export async function linkWebhookDeliveryExecution(
  env: Env,
  triggerId: string,
  deliveryId: string,
  executionId: string,
  processingToken: string
): Promise<void> {
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_deliveries SET execution_id = ?
      WHERE id = ? AND trigger_id = ? AND outcome = 'processing'
        AND processing_token = ? AND execution_id IS NULL`
  )
    .bind(executionId, deliveryId, triggerId, processingToken)
    .run();
  if (!result.meta.changes) throw new Error('Webhook delivery execution link failed');
}

export async function refreshWebhookDeliveryLease(
  env: Env,
  triggerId: string,
  deliveryId: string,
  executionId: string,
  processingToken: string
): Promise<void> {
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_deliveries SET processing_heartbeat_at = ?
      WHERE id = ? AND trigger_id = ? AND outcome = 'processing'
        AND processing_token = ? AND execution_id = ?`
  )
    .bind(new Date().toISOString(), deliveryId, triggerId, processingToken, executionId)
    .run();
  if (!result.meta.changes) throw new Error('Webhook delivery processing lease lost');
}

export async function recordWebhookRejectedDelivery(
  env: Env,
  input: {
    triggerId: string;
    outcome: Extract<WebhookDeliveryOutcome, 'configuration_error' | 'rate_limited'>;
    httpStatus: number;
    errorCode: string;
    windowStart: number;
    receivedAt: string;
  }
): Promise<void> {
  const limits = getWebhookTriggerLimits(env);
  const expiresAt = new Date(
    new Date(input.receivedAt).getTime() + limits.deliveryRetentionDays * 86_400_000
  ).toISOString();
  const id = `rejected:${input.triggerId}:${input.outcome}:${input.windowStart}`;
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO webhook_deliveries
      (id, trigger_id, idempotency_key_hash, request_fingerprint, outcome, http_status,
       body_bytes, received_at, processed_at, expires_at, error_code)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.triggerId,
      input.outcome,
      input.outcome,
      input.httpStatus,
      input.receivedAt,
      input.receivedAt,
      expiresAt,
      input.errorCode
    )
    .run();
}

interface WebhookDeliveryCursor {
  receivedAt: string;
  id: string;
}

export class InvalidWebhookDeliveryCursorError extends Error {
  constructor() {
    super('Invalid webhook delivery cursor');
    this.name = 'InvalidWebhookDeliveryCursorError';
  }
}

function encodeDeliveryCursor(cursor: WebhookDeliveryCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeDeliveryCursor(value: string): WebhookDeliveryCursor | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const parsed: unknown = JSON.parse(atob(base64));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.receivedAt === 'string' && typeof record.id === 'string'
      ? { receivedAt: record.receivedAt, id: record.id }
      : null;
  } catch {
    return null;
  }
}

export async function listWebhookDeliveries(
  env: Env,
  triggerId: string,
  cursor: string | undefined,
  limit: number
): Promise<ListWebhookDeliveriesResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const decodedCursor = cursor ? decodeDeliveryCursor(cursor) : null;
  if (cursor && !decodedCursor) throw new InvalidWebhookDeliveryCursorError();
  const rows = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(
      decodedCursor
        ? and(
            eq(schema.webhookDeliveries.triggerId, triggerId),
            or(
              lt(schema.webhookDeliveries.receivedAt, decodedCursor.receivedAt),
              and(
                eq(schema.webhookDeliveries.receivedAt, decodedCursor.receivedAt),
                lt(schema.webhookDeliveries.id, decodedCursor.id)
              )
            )
          )
        : eq(schema.webhookDeliveries.triggerId, triggerId)
    )
    .orderBy(desc(schema.webhookDeliveries.receivedAt), desc(schema.webhookDeliveries.id))
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
    nextCursor: hasMore
      ? (() => {
          const last = page.at(-1);
          return last ? encodeDeliveryCursor({ receivedAt: last.receivedAt, id: last.id }) : null;
        })()
      : null,
  };
}

export async function purgeExpiredWebhookDeliveries(env: Env): Promise<number> {
  const result = await env.DATABASE.prepare(
    `DELETE FROM webhook_deliveries WHERE id IN (
       SELECT id FROM webhook_deliveries WHERE expires_at < ?
       ORDER BY expires_at, id LIMIT ?
     )`
  )
    .bind(new Date().toISOString(), getWebhookTriggerLimits(env).deliveryCleanupBatchSize)
    .run();
  return Number(result.meta.changes ?? 0);
}
