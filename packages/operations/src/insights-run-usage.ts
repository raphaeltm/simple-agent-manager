/**
 * Run usage (Insights slice U): the shared reads of measured token usage, per run for the run
 * receipt (`runReceipt`) and per account for Insights · Accounts (`projectAccounts`). Build spec: idea
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
  type InsightsAccountSpend,
  type InsightsAccountTokens,
  PLATFORM_AI_MODELS,
  type RunModelUsage,
  type RunReceiptTokens,
  type RunTokenCounts,
  type RunUsageSource,
  type RunUsageSpend,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { type InsightsRows, parseInsightsRows } from './insights-batch';
import type { FlowStatement } from './insights-flow-sql';

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

/**
 * The usage rows that count, for a query that aliases `agent_run_usage` as `r`: a proxied run (one
 * with any AI proxy row) is read from its AI proxy rows only, because the proxy measured every call
 * the harness also reports. The probe seeks the unique key's prefix (project, chat session,
 * source). Shared with any per-run aggregate over `agent_run_usage` so no reader counts twice.
 */
export const COUNTED_RUN_USAGE_SQL = `(r.source = 'ai_proxy' OR NOT EXISTS (
    SELECT 1 FROM agent_run_usage p
     WHERE p.project_id = r.project_id AND p.chat_session_id = r.chat_session_id
       AND p.source = 'ai_proxy'))`;

/**
 * Whether the viewer may see a row's credential key: a shared (project or platform) account, the
 * viewer's own credential, or, when the key names no credential row (a deleted credential or a
 * long legacy key stored as a digest), a run the viewer started. Any other member's personal key
 * stays in the database, as `listProjectCredentialLimits` keeps their windows there. Binds:
 * viewer ×2.
 */
const KEY_VISIBLE_SQL = `COALESCE(r.credential_source IN ('project', 'platform')
      OR c.owner_id = ? OR (c.id IS NULL AND s.user_id = ?), 0)`;

/**
 * Measured usage per account and model since `sinceMs`, for Insights · Accounts. One row per
 * (visible key, owner, agent, credential kind, model); another member's personal key is redacted
 * to `ref = NULL, redacted = 1` and grouped with their other keys of the same kind, matching how
 * the Accounts tab groups their runs. Largest first, so the row cap drops the smallest usage.
 *
 * Every predicate binds the project: the usage rows (seeking `idx_agent_run_usage_project_updated`
 * by project and `updated_at`), the proxied-run probe (`COUNTED_RUN_USAGE_SQL`), and the session
 * join, which must belong to a workspace of this project. The credential columns read are `kind`
 * and `owner_id`; never the name or the token. Binds: viewer ×4, project, since (ms), cap + 1.
 */
export function accountUsageStatement(input: {
  projectId: string;
  viewerId: string;
  sinceMs: number;
  maxRows: number;
}): FlowStatement {
  return {
    sql: `WITH u AS (
      SELECT CASE WHEN r.credential_key <> '' THEN ${KEY_VISIBLE_SQL} END AS visible,
             r.credential_key AS key, r.credential_source AS cred_source,
             COALESCE(r.agent_type, s.agent_type) AS agent, c.kind AS cred_kind, c.id AS cred_id,
             c.owner_id AS cred_owner, s.user_id AS session_user, r.model AS usage_model,
             r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
             r.reasoning_tokens
        FROM agent_run_usage r
        LEFT JOIN cc_credentials c
          ON r.credential_key LIKE '${CC_CREDENTIAL_KEY_PREFIX}%'
         AND c.id = substr(r.credential_key, ${CC_CREDENTIAL_KEY_PREFIX.length + 1})
        LEFT JOIN agent_sessions s
          ON s.id = r.agent_session_id
         AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = s.workspace_id AND w.project_id = r.project_id)
       WHERE r.project_id = ? AND r.updated_at >= ? AND ${COUNTED_RUN_USAGE_SQL}
    )
    SELECT CASE WHEN visible = 1 THEN key END AS ref,
           CASE WHEN visible = 0 THEN 1 ELSE 0 END AS redacted,
           cred_source AS source, agent AS agent_type, cred_kind AS kind,
           CASE WHEN cred_id IS NULL THEN NULL WHEN cred_owner = ? THEN 1 ELSE 0 END AS cred_own,
           max(session_user = ?) AS session_own,
           usage_model AS model,
           TOTAL(input_tokens) AS input_tokens, TOTAL(output_tokens) AS output_tokens,
           TOTAL(cache_read_tokens) AS cache_read_tokens,
           TOTAL(cache_write_tokens) AS cache_write_tokens,
           CASE WHEN COUNT(reasoning_tokens) = 0 THEN NULL ELSE TOTAL(reasoning_tokens) END
             AS reasoning_tokens
      FROM u
     GROUP BY ref, redacted, source, agent_type, kind, cred_own, model
     ORDER BY TOTAL(input_tokens) + TOTAL(output_tokens) + TOTAL(cache_read_tokens)
                + TOTAL(cache_write_tokens) DESC,
              ref, redacted, source, agent_type, kind, cred_own, model
     LIMIT ?`,
    binds: [
      input.viewerId,
      input.viewerId,
      input.projectId,
      input.sinceMs,
      input.viewerId,
      input.viewerId,
      input.maxRows + 1,
    ],
  };
}

const flag = v.nullish(v.number());
const AccountUsageRowSchema = v.object({
  ref: v.nullish(v.pipe(v.string(), v.minLength(1))),
  redacted: v.picklist([0, 1]),
  source: v.nullish(v.string()),
  agent_type: v.nullish(v.string()),
  kind: v.nullish(v.string()),
  cred_own: flag,
  session_own: flag,
  model: v.string(),
  input_tokens: CountSchema,
  output_tokens: CountSchema,
  cache_read_tokens: CountSchema,
  cache_write_tokens: CountSchema,
  reasoning_tokens: v.nullable(CountSchema),
});

export interface AccountUsageRow extends RunTokenCounts {
  /** The credential limit key; null when redacted (another member's key) or none was recorded. */
  ref: string | null;
  /** Another member's personal key: the key was withheld, and so is its spend. */
  redacted: boolean;
  source: string | null;
  agentType: string | null;
  /** `cc_credentials.kind`, null when the key names no credential row. */
  kind: string | null;
  credOwn: number | null;
  sessionOwn: number | null;
  /** '' when the harness did not say which model ran. */
  model: string;
}

export interface AccountUsageRead {
  rows: AccountUsageRow[];
  /** True when the cap cut smaller rows off; totals are then a floor. */
  limited: boolean;
}

/** Validate the statement's rows one by one (`.claude/rules/50`), honouring the cap. */
export function parseAccountUsageRows(
  rows: InsightsRows | undefined,
  input: { projectId: string; maxRows: number }
): AccountUsageRead {
  const parsed = parseInsightsRows(
    rows?.slice(0, input.maxRows),
    AccountUsageRowSchema,
    'insights_accounts',
    'account_usage',
    input.projectId
  );
  return {
    rows: parsed.map((row) => ({
      ref: row.ref ?? null,
      redacted: row.redacted === 1,
      source: row.source ?? null,
      agentType: row.agent_type ?? null,
      kind: row.kind ?? null,
      credOwn: row.cred_own ?? null,
      sessionOwn: row.session_own ?? null,
      model: row.model,
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      reasoning: row.reasoning_tokens,
    })),
    limited: (rows?.length ?? 0) > input.maxRows,
  };
}

/** The credential kind whose usage SAM prices: a pay-as-you-go key to a catalog provider. */
const PRICED_CREDENTIAL_KIND = 'api-key';

/**
 * Tokens and spend for one Accounts row from the usage rows attached to it. `spendApplies` is
 * true for API-key accounts; anything else shows tokens only. Spend is an estimate at catalog
 * prices: a model without a price, or a custom OpenAI-compatible endpoint, is named in
 * `unpricedModels` rather than guessed, and makes the total a floor. Per merged pull request
 * divides the range's usage by the account's merged runs in the range.
 */
export function summarizeAccountUsage(
  rows: readonly AccountUsageRow[],
  options: { merged: number; spendApplies: boolean }
): { tokens: InsightsAccountTokens | null; spend: InsightsAccountSpend | null } {
  const merged = options.merged > 0 ? options.merged : null;
  const total = rows.reduce((sum, row) => sum + tokenTotal(row), 0);
  const tokens: InsightsAccountTokens | null =
    rows.length === 0
      ? null
      : { total, perMergedPullRequest: merged === null ? null : Math.round(total / merged) };
  if (!options.spendApplies) return { tokens, spend: null };
  if (rows.length === 0) return { tokens, spend: { state: 'not_reported' } };
  // Another member's personal key: their spend is theirs to see, like the key's name.
  if (rows.some((row) => row.redacted)) return { tokens, spend: { state: 'private' } };

  const unpriced = new Set<string>();
  const byModel = new Map<string, RunTokenCounts>();
  for (const row of rows) {
    if (row.kind !== PRICED_CREDENTIAL_KIND) {
      if (tokenTotal(row) > 0) unpriced.add(row.model || 'unknown model');
      continue;
    }
    byModel.set(row.model, addCounts(byModel.get(row.model) ?? ZERO, row));
  }
  let costUsd: number | null = null;
  for (const [model, counts] of byModel) {
    const estimate = estimateModelSpendUsd(model, counts);
    if (estimate === null) unpriced.add(model || 'unknown model');
    else costUsd = (costUsd ?? 0) + estimate;
  }
  if (costUsd !== null) costUsd = roundUsd(costUsd);
  return {
    tokens,
    spend: {
      state: 'reported',
      costUsd,
      perMergedPullRequestUsd:
        costUsd === null || merged === null ? null : roundUsd(costUsd / merged),
      unpricedModels: [...unpriced].sort((a, b) => a.localeCompare(b)),
    },
  };
}

function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
