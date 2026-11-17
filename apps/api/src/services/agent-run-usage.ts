/**
 * Insights slice U: writers for `agent_run_usage` (migration 0253), measured token usage per run.
 *
 * Two sources, never mixed in one row:
 * - `harness`: cumulative totals the VM agent reports on the usage callback
 *   (`handleAcpUsageCallback`). Each report carries the running totals of one usage epoch, so the
 *   upsert takes a per-column MAX: a repeated report changes nothing, an older report arriving late
 *   cannot lower a newer one, and a report lost in between is healed by the next.
 * - `ai_proxy`: one measured upstream response at a time, added to the run's row.
 *
 * Reads live in `packages/operations/src/insights-run-usage.ts`. Rows store a credential KEY
 * (`credentialLimitReferenceKey`), never a secret.
 */
import type { MeasuredTokenUsage } from '@simple-agent-manager/ai-proxy';
import {
  DEFAULT_RUN_USAGE_MAX_ROWS_PER_SESSION,
  DEFAULT_RUN_USAGE_RETENTION_BATCH_SIZE,
  DEFAULT_RUN_USAGE_RETENTION_DAYS,
  RUN_USAGE_MAX_TOKENS_PER_COUNTER,
} from '@simple-agent-manager/shared';
import { parsePositiveInt } from '@simple-agent-manager/worker-core';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { credentialLimitReferenceKey } from './credential-limit-events';

export const AI_PROXY_USAGE_EPOCH = 'ai_proxy';

export interface RunUsageModelCounts {
  /** '' when the harness did not say which model ran. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when reasoning is not reported separately (it is then part of output). */
  reasoningTokens: number | null;
}

export interface RunUsageScope {
  projectId: string;
  chatSessionId: string;
  workspaceId: string | null;
  agentSessionId: string | null;
  agentType: string | null;
  credentialReference: string | null;
  credentialSource: string | null;
}

const UPSERT_COLUMNS = `project_id, chat_session_id, workspace_id, agent_session_id, source, usage_epoch,
    model, credential_key, credential_source, agent_type, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at, updated_at`;
const UPSERT_VALUES = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';
const CONFLICT_KEY = 'project_id, chat_session_id, source, usage_epoch, model, credential_key';

/**
 * Admit every model in one statement or none. The count and insert share SQLite's write boundary,
 * so concurrent client-selected epochs cannot race past the configured per-run row ceiling.
 */
const HARNESS_UPSERT_SQL = `WITH report(
    project_id, chat_session_id, workspace_id, agent_session_id, usage_epoch, credential_key,
    credential_source, agent_type, reported_at, max_rows, models_json
  ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)),
  incoming_raw AS (
    SELECT
      TRIM(CAST(json_extract(model.value, '$.model') AS TEXT)) AS model,
      CAST(json_extract(model.value, '$.inputTokens') AS INTEGER) AS input_tokens,
      CAST(json_extract(model.value, '$.outputTokens') AS INTEGER) AS output_tokens,
      CAST(json_extract(model.value, '$.cacheReadTokens') AS INTEGER) AS cache_read_tokens,
      CAST(json_extract(model.value, '$.cacheWriteTokens') AS INTEGER) AS cache_write_tokens,
      CAST(json_extract(model.value, '$.reasoningTokens') AS INTEGER) AS reasoning_tokens
    FROM report, json_each(report.models_json) AS model
  ),
  incoming AS (
    SELECT model, MAX(input_tokens) AS input_tokens, MAX(output_tokens) AS output_tokens,
      MAX(cache_read_tokens) AS cache_read_tokens,
      MAX(cache_write_tokens) AS cache_write_tokens,
      MAX(reasoning_tokens) AS reasoning_tokens
    FROM incoming_raw
    GROUP BY model
  ),
  usage_counts AS (
    SELECT
      (SELECT COUNT(*) FROM agent_run_usage existing
        WHERE existing.project_id = report.project_id
          AND existing.chat_session_id = report.chat_session_id
          AND existing.source = 'harness') AS existing_rows,
      (SELECT COUNT(*) FROM incoming
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_run_usage existing
          WHERE existing.project_id = report.project_id
            AND existing.chat_session_id = report.chat_session_id
            AND existing.source = 'harness'
            AND existing.usage_epoch = report.usage_epoch
            AND existing.model = incoming.model
            AND existing.credential_key = report.credential_key
        )) AS new_rows
    FROM report
  ),
  admission AS (
    SELECT new_rows = 0 OR existing_rows + new_rows <= report.max_rows AS allowed
    FROM report, usage_counts
  )
INSERT INTO agent_run_usage (${UPSERT_COLUMNS})
  SELECT report.project_id, report.chat_session_id, report.workspace_id,
    report.agent_session_id, 'harness', report.usage_epoch, incoming.model,
    report.credential_key, report.credential_source, report.agent_type,
    incoming.input_tokens, incoming.output_tokens, incoming.cache_read_tokens,
    incoming.cache_write_tokens, incoming.reasoning_tokens, report.reported_at, report.reported_at
  FROM report, incoming, admission
  WHERE admission.allowed
  ON CONFLICT (${CONFLICT_KEY}) DO UPDATE SET
    input_tokens = MAX(input_tokens, excluded.input_tokens),
    output_tokens = MAX(output_tokens, excluded.output_tokens),
    cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens),
    cache_write_tokens = MAX(cache_write_tokens, excluded.cache_write_tokens),
    reasoning_tokens = CASE
      WHEN excluded.reasoning_tokens IS NULL THEN reasoning_tokens
      WHEN reasoning_tokens IS NULL THEN excluded.reasoning_tokens
      ELSE MAX(reasoning_tokens, excluded.reasoning_tokens) END,
    workspace_id = COALESCE(excluded.workspace_id, workspace_id),
    agent_session_id = COALESCE(excluded.agent_session_id, agent_session_id),
    updated_at = MAX(updated_at, excluded.updated_at)
  -- A repeated or older report changes no counter: write nothing.
  WHERE excluded.input_tokens > input_tokens
     OR excluded.output_tokens > output_tokens
     OR excluded.cache_read_tokens > cache_read_tokens
     OR excluded.cache_write_tokens > cache_write_tokens
     OR (excluded.reasoning_tokens IS NOT NULL
         AND (reasoning_tokens IS NULL OR excluded.reasoning_tokens > reasoning_tokens))`;

/** Increments: one measured upstream response added to the run's row. */
const PROXY_UPSERT_SQL = `INSERT INTO agent_run_usage (${UPSERT_COLUMNS})
  VALUES (${UPSERT_VALUES})
  ON CONFLICT (${CONFLICT_KEY}) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    reasoning_tokens = CASE
      WHEN excluded.reasoning_tokens IS NULL THEN reasoning_tokens
      ELSE COALESCE(reasoning_tokens, 0) + excluded.reasoning_tokens END,
    workspace_id = COALESCE(excluded.workspace_id, workspace_id),
    agent_session_id = COALESCE(excluded.agent_session_id, agent_session_id),
    updated_at = MAX(updated_at, excluded.updated_at)`;

/** Counters are clamped to the report ceiling so summed reads stay inside SQLite's integer range. */
function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), RUN_USAGE_MAX_TOKENS_PER_COUNTER)
    : 0;
}

function optionalCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), RUN_USAGE_MAX_TOKENS_PER_COUNTER)
    : null;
}

function hasTokens(counts: RunUsageModelCounts): boolean {
  return (
    count(counts.inputTokens) +
      count(counts.outputTokens) +
      count(counts.cacheReadTokens) +
      count(counts.cacheWriteTokens) +
      count(counts.reasoningTokens) >
    0
  );
}

function normalizedModels(models: RunUsageModelCounts[]): RunUsageModelCounts[] {
  return models.filter(hasTokens).map((counts) => ({
    model: counts.model.trim(),
    inputTokens: count(counts.inputTokens),
    outputTokens: count(counts.outputTokens),
    cacheReadTokens: count(counts.cacheReadTokens),
    cacheWriteTokens: count(counts.cacheWriteTokens),
    reasoningTokens: optionalCount(counts.reasoningTokens),
  }));
}

async function bindProxyRows(
  db: D1Database,
  scope: RunUsageScope,
  models: RunUsageModelCounts[],
  now: number
): Promise<D1PreparedStatement[]> {
  const credentialKey = (await credentialLimitReferenceKey(scope.credentialReference)) ?? '';
  return normalizedModels(models)
    .map((counts) =>
      db
        .prepare(PROXY_UPSERT_SQL)
        .bind(
          scope.projectId,
          scope.chatSessionId,
          scope.workspaceId,
          scope.agentSessionId,
          'ai_proxy',
          AI_PROXY_USAGE_EPOCH,
          counts.model,
          credentialKey,
          credentialKey ? scope.credentialSource : null,
          scope.agentType,
          counts.inputTokens,
          counts.outputTokens,
          counts.cacheReadTokens,
          counts.cacheWriteTokens,
          counts.reasoningTokens,
          now,
          now
        )
    );
}

/**
 * Store one harness report: the cumulative totals of `epoch`, per model. One D1 round trip.
 * The caller has already verified the callback token, the session binding and the credential
 * attribution; `scope` carries only server-verified values.
 */
export async function recordHarnessRunUsage(
  env: Pick<Env, 'DATABASE' | 'RUN_USAGE_MAX_ROWS_PER_SESSION'>,
  scope: RunUsageScope,
  epoch: string,
  models: RunUsageModelCounts[],
  now: number = Date.now()
): Promise<number> {
  const normalized = normalizedModels(models);
  if (normalized.length === 0) return 0;
  const credentialKey = (await credentialLimitReferenceKey(scope.credentialReference)) ?? '';
  const result = await env.DATABASE.prepare(HARNESS_UPSERT_SQL)
    .bind(
      scope.projectId,
      scope.chatSessionId,
      scope.workspaceId,
      scope.agentSessionId,
      epoch,
      credentialKey,
      credentialKey ? scope.credentialSource : null,
      scope.agentType,
      now,
      parsePositiveInt(
        env.RUN_USAGE_MAX_ROWS_PER_SESSION,
        DEFAULT_RUN_USAGE_MAX_ROWS_PER_SESSION
      ),
      JSON.stringify(normalized)
    )
    .run();
  return result.meta.changes ?? 0;
}

/** Delete one indexed batch of expired measured usage; the daily caller repeats on its next run. */
export async function purgeExpiredRunUsage(
  env: Pick<Env, 'DATABASE' | 'RUN_USAGE_RETENTION_DAYS' | 'RUN_USAGE_RETENTION_BATCH_SIZE'>,
  now: number = Date.now()
): Promise<number> {
  const retentionDays = parsePositiveInt(
    env.RUN_USAGE_RETENTION_DAYS,
    DEFAULT_RUN_USAGE_RETENTION_DAYS
  );
  const batchSize = parsePositiveInt(
    env.RUN_USAGE_RETENTION_BATCH_SIZE,
    DEFAULT_RUN_USAGE_RETENTION_BATCH_SIZE
  );
  const cutoff = now - retentionDays * 86_400_000;
  const result = await env.DATABASE.prepare(
    `DELETE FROM agent_run_usage WHERE id IN (
       SELECT id FROM agent_run_usage WHERE updated_at < ? ORDER BY updated_at, id LIMIT ?
     )`
  )
    .bind(cutoff, batchSize)
    .run();
  return result.meta.changes ?? 0;
}

/** Cumulative token totals of one VM-agent usage epoch, per model (the callback's `tokenUsage`). */
export interface HarnessTokenUsageReport {
  epoch: string;
  models: Array<{
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  }>;
}

/**
 * Store a usage callback's token report. A failed write is logged and swallowed: totals are
 * cumulative, so the next report restores what this one carried, and the callback's limit
 * observations must not be retried because of it.
 */
export async function recordHarnessTokenReport(
  env: Pick<Env, 'DATABASE' | 'RUN_USAGE_MAX_ROWS_PER_SESSION'>,
  scope: RunUsageScope,
  report: HarnessTokenUsageReport
): Promise<void> {
  try {
    await recordHarnessRunUsage(
      env,
      scope,
      report.epoch,
      report.models.map((model) => ({
        model: model.model ?? '',
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        cacheReadTokens: model.cacheReadTokens ?? 0,
        cacheWriteTokens: model.cacheWriteTokens ?? 0,
        reasoningTokens: model.reasoningTokens ?? null,
      }))
    );
  } catch (error) {
    log.warn('agent_run_usage.harness_record_failed', {
      projectId: scope.projectId,
      chatSessionId: scope.chatSessionId,
      agentSessionId: scope.agentSessionId,
      error: error instanceof Error ? error.message : String(error),
      action: 'skipped',
    });
  }
}

/**
 * Add one measured AI proxy response to the run. A workspace with no chat session or project is
 * not a run and is skipped; a failure is logged, never thrown into the proxied response.
 */
export async function recordProxyRunUsage(
  env: Pick<Env, 'DATABASE'>,
  scope: Omit<RunUsageScope, 'chatSessionId' | 'projectId'> & {
    projectId: string | null;
    chatSessionId: string | null;
  },
  model: string,
  usage: MeasuredTokenUsage,
  now: number = Date.now()
): Promise<void> {
  if (!scope.projectId || !scope.chatSessionId) {
    // Not a run (no project or chat bound to the workspace right now); said once per response.
    log.info('agent_run_usage.proxy_skipped_no_run', {
      workspaceId: scope.workspaceId,
      hasProject: Boolean(scope.projectId),
      hasChatSession: Boolean(scope.chatSessionId),
    });
    return;
  }
  try {
    const statements = await bindProxyRows(
      env.DATABASE,
      { ...scope, projectId: scope.projectId, chatSessionId: scope.chatSessionId },
      [{ model, ...usage }],
      now
    );
    if (statements.length === 0) return;
    await env.DATABASE.batch(statements);
  } catch (error) {
    log.warn('agent_run_usage.proxy_record_failed', {
      projectId: scope.projectId,
      chatSessionId: scope.chatSessionId,
      workspaceId: scope.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The `onMeasuredUsage` hook for one proxied request: adds the upstream's measured usage to the
 * run of the workspace the proxy token belongs to. `auth` is the verified proxy auth; the
 * credential is the one the proxy actually forwarded with.
 */
export function proxyRunUsageRecorder(
  env: Pick<Env, 'DATABASE'>,
  auth: {
    projectId?: string | null;
    chatSessionId?: string | null;
    workspaceId: string;
    agentSessionId?: string | null;
    agentType?: string | null;
  },
  attribution: {
    model: string | null | undefined;
    credentialReference: string | null;
    credentialSource: string | null;
  }
): (usage: MeasuredTokenUsage) => Promise<void> {
  return (usage) =>
    recordProxyRunUsage(
      env,
      {
        projectId: auth.projectId ?? null,
        chatSessionId: auth.chatSessionId ?? null,
        workspaceId: auth.workspaceId,
        agentSessionId: auth.agentSessionId ?? null,
        agentType: auth.agentType ?? null,
        credentialReference: attribution.credentialReference,
        credentialSource: attribution.credentialSource,
      },
      attribution.model ?? '',
      usage
    );
}
