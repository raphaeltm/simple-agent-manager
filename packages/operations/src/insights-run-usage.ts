/**
 * Run usage (Insights slice U): the shared read of measured token usage per run, used by the run
 * receipt (`runReceipt`). Build spec: idea
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
    TOTAL(r.input_tokens) AS input_tokens, TOTAL(r.output_tokens) AS output_tokens,
    TOTAL(r.cache_read_tokens) AS cache_read_tokens,
    TOTAL(r.cache_write_tokens) AS cache_write_tokens,
    CASE WHEN COUNT(r.reasoning_tokens) = 0 THEN NULL ELSE TOTAL(r.reasoning_tokens) END
      AS reasoning_tokens
  FROM agent_run_usage r
  LEFT JOIN cc_credentials c
    ON r.credential_key LIKE '${CC_CREDENTIAL_KEY_PREFIX}%'
   AND c.id = substr(r.credential_key, ${CC_CREDENTIAL_KEY_PREFIX.length + 1})
  WHERE r.project_id = ? AND r.chat_session_id = ?
  GROUP BY r.source, r.model, r.credential_key
  ORDER BY r.source, r.model, r.credential_key
  LIMIT ?`;

// TOTAL() never overflows (it sums as a float), so one hostile or buggy reporter cannot make the
// read throw; the counts come back whole numbers well inside the safe integer range.
const CountSchema = v.pipe(
  v.number(),
  v.minValue(0),
  v.transform((value) => Math.round(value))
);

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
      source: typeof candidate.source === 'string' ? candidate.source : null,
      model: typeof candidate.model === 'string' ? candidate.model.slice(0, 160) : null,
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

function tokenTotal(counts: RunTokenCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

const ZERO: RunTokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null };

/**
 * The receipt's `tokens` section. Spend is an estimate shown only when every row's account is a
 * SAM API-key credential; subscription and platform accounts show tokens only. `spendVisible`
 * false (another member's personal key) hides the money, as account names are hidden.
 */
export function summarizeRunTokens(
  read: RunUsageRead | null,
  options: { spendVisible: boolean } = { spendVisible: true }
): RunReceiptTokens {
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
  if (spend.state === 'estimate' && !options.spendVisible) spend = { state: 'private' };

  // Largest first, so the model that did the work leads; ties by name for a stable order.
  const ordered = [...byModel.entries()].sort(
    ([nameA, a], [nameB, b]) => tokenTotal(b) - tokenTotal(a) || nameA.localeCompare(nameB)
  );
  const models: RunModelUsage[] = ordered.map(([model, counts]) => {
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
