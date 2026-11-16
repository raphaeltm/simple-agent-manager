/**
 * Run usage (Insights slice U): the shared read of measured token usage per run. Used by the run
 * receipt (`runReceipt`) and, for API-key spend, by the Accounts tab (slice A). Build spec: idea
 * 01M7HTS38KX2G78JD0ESAGMKKH. Rows are written by `apps/api/src/services/agent-run-usage.ts`
 * (migration 0253).
 *
 * Scope: every statement binds `project_id` (rule 11). A chat session of another project reads
 * exactly like one with no usage.
 *
 * Measured, or marked missing: a run with no rows is `not_reported`. When the AI proxy measured a
 * run it is the only source read for that run, because a proxied harness reports the same calls.
 */
import {
  PLATFORM_AI_MODELS,
  type RunModelUsage,
  type RunReceiptTokens,
  type RunTokenCounts,
  type RunUsageSource,
  type RunUsageSpend,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

/** The `cc_credentials` reference prefix stored verbatim in `credential_key` for short keys. */
const CC_CREDENTIAL_KEY_PREFIX = 'cc_credentials:';

const RUN_USAGE_SQL = `SELECT r.source AS source, r.model AS model, r.credential_key AS credential_key,
    c.kind AS credential_kind, MAX(r.credential_source) AS credential_source,
    SUM(r.input_tokens) AS input_tokens, SUM(r.output_tokens) AS output_tokens,
    SUM(r.cache_read_tokens) AS cache_read_tokens, SUM(r.cache_write_tokens) AS cache_write_tokens,
    CASE WHEN COUNT(r.reasoning_tokens) = 0 THEN NULL ELSE SUM(r.reasoning_tokens) END
      AS reasoning_tokens
  FROM agent_run_usage r
  LEFT JOIN cc_credentials c
    ON r.credential_key LIKE '${CC_CREDENTIAL_KEY_PREFIX}%'
   AND c.id = substr(r.credential_key, ${CC_CREDENTIAL_KEY_PREFIX.length + 1})
  WHERE r.project_id = ? AND r.chat_session_id = ?
  GROUP BY r.source, r.model, r.credential_key
  ORDER BY r.source, r.model, r.credential_key
  LIMIT ?`;

const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const RunUsageRowSchema = v.object({
  source: v.picklist(['harness', 'ai_proxy']),
  model: v.string(),
  credential_key: v.string(),
  credential_kind: v.nullable(v.string()),
  credential_source: v.nullable(v.string()),
  input_tokens: CountSchema,
  output_tokens: CountSchema,
  cache_read_tokens: CountSchema,
  cache_write_tokens: CountSchema,
  reasoning_tokens: v.nullable(CountSchema),
});

type RunUsageRow = v.InferOutput<typeof RunUsageRowSchema>;

export interface RunUsageModelRow extends RunTokenCounts {
  /** '' when the harness did not say which model ran. */
  model: string;
  /** `credentialLimitReferenceKey()` of the run's account; '' when none was attributed. */
  credentialKey: string;
  /**
   * `cc_credentials.kind` when the key names a SAM credential, `platform` for SAM's own platform
   * credential, else null (no attribution, a legacy digest key, a deleted credential).
   */
  credentialKind: string | null;
}

function credentialKindOf(row: {
  credential_kind: string | null;
  credential_source: string | null;
}): string | null {
  if (row.credential_kind) return row.credential_kind;
  return row.credential_source === 'platform' ? 'platform' : null;
}

export interface RunUsageRead {
  source: RunUsageSource;
  models: RunUsageModelRow[];
  /** True when the run had more rows than `maxRows`; totals are then a floor. */
  limited: boolean;
}

/**
 * Measured token usage of one run, by model and account, or null when nothing was reported.
 * One round trip. Callers authorize the project first.
 */
export async function readRunUsage(
  db: D1Database,
  input: { projectId: string; chatSessionId: string; maxRows: number }
): Promise<RunUsageRead | null> {
  const result = await db
    .prepare(RUN_USAGE_SQL)
    .bind(input.projectId, input.chatSessionId, input.maxRows + 1)
    .all<Record<string, unknown>>();
  const raw = result.results ?? [];
  const rows: RunUsageRow[] = [];
  // One unreadable row is skipped and logged, never the whole read (rule 50).
  for (const candidate of raw.slice(0, input.maxRows)) {
    const parsed = v.safeParse(RunUsageRowSchema, candidate);
    if (parsed.success) {
      rows.push(parsed.output);
      continue;
    }
    log.warn('insights_run_usage.row_skipped', {
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      issue: parsed.issues[0]?.path?.map((item) => String(item.key)).join('.') ?? '(root)',
      action: 'skipped',
    });
  }
  // The proxy saw every call a proxied run made; the harness's own report of those calls would
  // count them twice.
  const source: RunUsageSource = rows.some((row) => row.source === 'ai_proxy')
    ? 'ai_proxy'
    : 'harness';
  const models = rows
    .filter((row) => row.source === source)
    .map((row) => ({
      model: row.model,
      credentialKey: row.credential_key,
      credentialKind: credentialKindOf(row),
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      reasoning: row.reasoning_tokens,
    }));
  if (models.length === 0) return null;
  return { source, models, limited: raw.length > input.maxRows };
}

/** Catalog id for a harness model name: Claude Code decorates ids such as `claude-x[1m]`. */
function catalogModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').trim();
}

/**
 * Estimated USD for one model's tokens at SAM's catalog prices, or null when the model has no
 * price. Cache reads use the cached-input price where the catalog has one; cache writes use the
 * input price. It is a labelled estimate, never a bill.
 */
export function estimateModelSpendUsd(model: string, counts: RunTokenCounts): number | null {
  const id = catalogModelId(model);
  const price = PLATFORM_AI_MODELS.find((candidate) => candidate.id === id);
  if (!price) return null;
  const cachedPrice = price.costPer1kCachedInputTokens ?? price.costPer1kInputTokens;
  const usd =
    ((counts.input + counts.cacheWrite) * price.costPer1kInputTokens +
      counts.cacheRead * cachedPrice +
      counts.output * price.costPer1kOutputTokens) /
    1000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

function addCounts(total: RunTokenCounts, row: RunTokenCounts): RunTokenCounts {
  return {
    input: total.input + row.input,
    output: total.output + row.output,
    cacheRead: total.cacheRead + row.cacheRead,
    cacheWrite: total.cacheWrite + row.cacheWrite,
    reasoning: row.reasoning === null ? total.reasoning : (total.reasoning ?? 0) + row.reasoning,
  };
}

const ZERO: RunTokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null };

/**
 * The receipt's `tokens` section. Spend is an estimate shown only when every row's account is a
 * SAM API-key credential; subscription and platform accounts show tokens only.
 */
export function summarizeRunTokens(read: RunUsageRead | null): RunReceiptTokens {
  if (!read) return { state: 'not_reported' };
  // One row per model even when the run switched accounts or restarted its agent.
  const byModel = new Map<string, RunTokenCounts>();
  for (const row of read.models) {
    byModel.set(row.model, addCounts(byModel.get(row.model) ?? ZERO, row));
  }
  const kinds = new Set(read.models.map((row) => row.credentialKind));
  let spend: RunUsageSpend;
  if (kinds.has(null)) spend = { state: 'unknown_account' };
  else if (kinds.size === 1 && kinds.has('api-key'))
    spend = { state: 'estimate', usd: null, unpricedModels: [] };
  else spend = { state: 'not_applicable' };

  const models: RunModelUsage[] = [...byModel.entries()].map(([model, counts]) => {
    const estimate = spend.state === 'estimate' ? estimateModelSpendUsd(model, counts) : null;
    if (spend.state === 'estimate') {
      if (estimate === null) spend.unpricedModels.push(model || 'unknown model');
      else spend.usd = (spend.usd ?? 0) + estimate;
    }
    return { model: model || null, ...counts, estimatedSpendUsd: estimate };
  });
  if (spend.state === 'estimate' && spend.usd !== null) {
    spend.usd = Math.round(spend.usd * 1_000_000) / 1_000_000;
  }
  return {
    state: 'reported',
    source: read.source,
    models,
    total: models.reduce<RunTokenCounts>((total, row) => addCounts(total, row), ZERO),
    spend,
    limited: read.limited,
  };
}

const ACCOUNT_USAGE_SQL = `SELECT r.credential_key AS credential_key, r.model AS model,
    c.kind AS credential_kind, MAX(r.credential_source) AS credential_source,
    COUNT(DISTINCT r.chat_session_id) AS runs,
    SUM(r.input_tokens) AS input_tokens, SUM(r.output_tokens) AS output_tokens,
    SUM(r.cache_read_tokens) AS cache_read_tokens, SUM(r.cache_write_tokens) AS cache_write_tokens,
    CASE WHEN COUNT(r.reasoning_tokens) = 0 THEN NULL ELSE SUM(r.reasoning_tokens) END
      AS reasoning_tokens
  FROM agent_run_usage r
  LEFT JOIN cc_credentials c
    ON r.credential_key LIKE '${CC_CREDENTIAL_KEY_PREFIX}%'
   AND c.id = substr(r.credential_key, ${CC_CREDENTIAL_KEY_PREFIX.length + 1})
  WHERE r.project_id = ? AND r.updated_at >= ? AND r.credential_key != ''
    AND (r.source = 'ai_proxy' OR NOT EXISTS (
      SELECT 1 FROM agent_run_usage p
       WHERE p.project_id = r.project_id AND p.chat_session_id = r.chat_session_id
         AND p.source = 'ai_proxy'))
  GROUP BY r.credential_key, r.model
  ORDER BY r.credential_key, r.model
  LIMIT ?`;

const AccountUsageRowSchema = v.object({
  ...v.omit(RunUsageRowSchema, ['source']).entries,
  runs: CountSchema,
});

export interface AccountModelUsage extends RunUsageModelRow {
  /** Runs (chat sessions) with usage on this account and model in the window. */
  runs: number;
  /** Estimate at catalog prices, only for API-key accounts; null otherwise or when unpriced. */
  estimatedSpendUsd: number | null;
}

/**
 * Token usage per account (credential key) and model across a project's runs updated since
 * `sinceMs`, for the Accounts tab. A proxied run is read from the proxy only, as in
 * `readRunUsage`. One round trip; callers authorize the project first.
 */
export async function readAccountUsage(
  db: D1Database,
  input: { projectId: string; sinceMs: number; maxRows: number }
): Promise<{ rows: AccountModelUsage[]; limited: boolean }> {
  const result = await db
    .prepare(ACCOUNT_USAGE_SQL)
    .bind(input.projectId, input.sinceMs, input.maxRows + 1)
    .all<Record<string, unknown>>();
  const raw = result.results ?? [];
  const rows: AccountModelUsage[] = [];
  for (const candidate of raw.slice(0, input.maxRows)) {
    const parsed = v.safeParse(AccountUsageRowSchema, candidate);
    if (!parsed.success) {
      log.warn('insights_run_usage.account_row_skipped', {
        projectId: input.projectId,
        issue: parsed.issues[0]?.path?.map((item) => String(item.key)).join('.') ?? '(root)',
        action: 'skipped',
      });
      continue;
    }
    const row = parsed.output;
    const counts: RunTokenCounts = {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      reasoning: row.reasoning_tokens,
    };
    const credentialKind = credentialKindOf(row);
    rows.push({
      model: row.model,
      credentialKey: row.credential_key,
      credentialKind,
      runs: row.runs,
      ...counts,
      estimatedSpendUsd:
        credentialKind === 'api-key' ? estimateModelSpendUsd(row.model, counts) : null,
    });
  }
  return { rows, limited: raw.length > input.maxRows };
}
