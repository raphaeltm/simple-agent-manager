import { DurableObject } from 'cloudflare:workers';

import {
  COST_ESTIMATE_BUCKET_MS,
  type CostEstimateWrite,
  type GatewayAdmissionSnapshot,
} from './ai-cost-estimate';
import { type AiModelUsageRow, parseModelUsageRow } from './ai-model-usage';
import type {
  AiProviderUsageAttribution,
  AiProviderUsageEntry,
  TokenBudget,
} from './ai-token-budget';
import type { AiProxyEnv } from './env';

export class AiTokenBudgetCounter extends DurableObject<AiProxyEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AiProxyEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ai_token_budget (
          budget_date   TEXT PRIMARY KEY NOT NULL,
          input_tokens  INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          updated_at    INTEGER NOT NULL
        )`
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ai_provider_usage (
          budget_date        TEXT NOT NULL,
          provider_id        TEXT NOT NULL,
          provider_name      TEXT NOT NULL,
          provider_dialect   TEXT NOT NULL,
          requests           INTEGER NOT NULL DEFAULT 0,
          input_tokens       INTEGER NOT NULL DEFAULT 0,
          output_tokens      INTEGER NOT NULL DEFAULT 0,
          estimated_cost_usd REAL NOT NULL DEFAULT 0,
          updated_at         INTEGER NOT NULL,
          PRIMARY KEY (budget_date, provider_id, provider_dialect)
        )`
      );
      // Per-model spend SAM priced itself, for usage breakdowns without AI Gateway
      // (./ai-model-usage.ts). Additive; one row per user, day and model.
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ai_model_usage (
          budget_date        TEXT NOT NULL,
          model_id           TEXT NOT NULL,
          provider_id        TEXT NOT NULL,
          requests           INTEGER NOT NULL DEFAULT 0,
          input_tokens       INTEGER NOT NULL DEFAULT 0,
          output_tokens      INTEGER NOT NULL DEFAULT 0,
          estimated_cost_usd REAL NOT NULL DEFAULT 0,
          updated_at         INTEGER NOT NULL,
          PRIMARY KEY (budget_date, model_id)
        )`
      );
      // Catalog-priced estimate that backstops the AI Gateway total (./ai-cost-estimate.ts).
      // Gateway installs only; never shown as spend. Buckets are pruned past their retention.
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ai_cost_estimate_bucket (
          bucket_start       INTEGER PRIMARY KEY NOT NULL,
          estimated_cost_usd REAL NOT NULL DEFAULT 0,
          updated_at         INTEGER NOT NULL
        )`
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ai_cost_estimate_month (
          budget_month       TEXT PRIMARY KEY NOT NULL,
          estimated_cost_usd REAL NOT NULL DEFAULT 0,
          updated_at         INTEGER NOT NULL
        )`
      );
    });
  }

  async get(dateKey: string): Promise<TokenBudget> {
    return this.readBudget(dateKey);
  }

  async consumeTotal(
    dateKey: string,
    tokenLimit: number,
    tokens: number
  ): Promise<{ allowed: boolean; usedTokens: number }> {
    return this.ctx.storage.transactionSync(() => {
      const current = this.readBudget(dateKey).inputTokens;
      if (current + tokens > tokenLimit) return { allowed: false, usedTokens: current };
      const usedTokens = current + tokens;
      this.sql.exec(
        `INSERT INTO ai_token_budget (budget_date, input_tokens, output_tokens, updated_at)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(budget_date) DO UPDATE SET
           input_tokens = excluded.input_tokens,
           updated_at = excluded.updated_at`,
        dateKey,
        usedTokens,
        Date.now()
      );
      return { allowed: true, usedTokens };
    });
  }

  async releaseTotal(dateKey: string, tokens: number): Promise<number> {
    return this.ctx.storage.transactionSync(() => {
      const usedTokens = Math.max(0, this.readBudget(dateKey).inputTokens - tokens);
      this.sql.exec(
        `INSERT INTO ai_token_budget (budget_date, input_tokens, output_tokens, updated_at)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(budget_date) DO UPDATE SET
           input_tokens = excluded.input_tokens,
           updated_at = excluded.updated_at`,
        dateKey,
        usedTokens,
        Date.now()
      );
      return usedTokens;
    });
  }

  async increment(
    dateKey: string,
    inputTokens: number,
    outputTokens: number,
    costEstimate?: CostEstimateWrite
  ): Promise<TokenBudget> {
    // One synchronous transaction: the day's tokens and the cost estimate move together (rule 45).
    return this.ctx.storage.transactionSync(() => {
      if (costEstimate) this.recordCostEstimate(costEstimate);
      const current = this.readBudget(dateKey);
      const updated = {
        inputTokens: current.inputTokens + inputTokens,
        outputTokens: current.outputTokens + outputTokens,
      };

      this.sql.exec(
        `INSERT INTO ai_token_budget (budget_date, input_tokens, output_tokens, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(budget_date) DO UPDATE SET
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           updated_at = excluded.updated_at`,
        dateKey,
        updated.inputTokens,
        updated.outputTokens,
        Date.now()
      );

      return updated;
    });
  }

  async incrementProviderUsage(
    dateKey: string,
    attribution: AiProviderUsageAttribution,
    inputTokens: number,
    outputTokens: number,
    estimatedCostUsd: number,
    modelId?: string
  ): Promise<void> {
    // One synchronous transaction, no await inside: provider and model rows move together and no
    // concurrent call on this object can interleave (rule 45).
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO ai_provider_usage (
           budget_date, provider_id, provider_name, provider_dialect,
           requests, input_tokens, output_tokens, estimated_cost_usd, updated_at
         )
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(budget_date, provider_id, provider_dialect) DO UPDATE SET
           provider_name = excluded.provider_name,
           requests = ai_provider_usage.requests + 1,
           input_tokens = ai_provider_usage.input_tokens + excluded.input_tokens,
           output_tokens = ai_provider_usage.output_tokens + excluded.output_tokens,
           estimated_cost_usd = ai_provider_usage.estimated_cost_usd + excluded.estimated_cost_usd,
           updated_at = excluded.updated_at`,
        dateKey,
        attribution.providerId,
        attribution.providerName,
        attribution.dialect,
        inputTokens,
        outputTokens,
        estimatedCostUsd,
        Date.now()
      );
      if (!modelId) return;
      this.sql.exec(
        `INSERT INTO ai_model_usage (
           budget_date, model_id, provider_id, requests, input_tokens, output_tokens,
           estimated_cost_usd, updated_at
         )
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(budget_date, model_id) DO UPDATE SET
           provider_id = excluded.provider_id,
           requests = ai_model_usage.requests + 1,
           input_tokens = ai_model_usage.input_tokens + excluded.input_tokens,
           output_tokens = ai_model_usage.output_tokens + excluded.output_tokens,
           estimated_cost_usd = ai_model_usage.estimated_cost_usd + excluded.estimated_cost_usd,
           updated_at = excluded.updated_at`,
        dateKey,
        modelId,
        attribution.providerId,
        inputTokens,
        outputTokens,
        estimatedCostUsd,
        Date.now()
      );
    });
  }

  /** Per-day, per-model rows since `startDateKey`: days in the period (≤ 90) x priced models used. */
  async getModelUsage(startDateKey: string): Promise<AiModelUsageRow[]> {
    return this.sql
      .exec(
        `SELECT budget_date, model_id, provider_id, requests, input_tokens, output_tokens,
                estimated_cost_usd
         FROM ai_model_usage
         WHERE budget_date >= ?`,
        startDateKey
      )
      .toArray()
      .flatMap((row) => parseModelUsageRow(row) ?? []);
  }

  async getProviderUsage(startDateKey: string): Promise<AiProviderUsageEntry[]> {
    return this.sql
      .exec<{
        provider_id: string;
        provider_name: string;
        provider_dialect: string;
        requests: number;
        input_tokens: number;
        output_tokens: number;
        estimated_cost_usd: number;
      }>(
        `SELECT
           provider_id,
           MAX(provider_name) AS provider_name,
           provider_dialect,
           SUM(requests) AS requests,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(estimated_cost_usd) AS estimated_cost_usd
         FROM ai_provider_usage
         WHERE budget_date >= ?
         GROUP BY provider_id, provider_dialect`,
        startDateKey
      )
      .toArray()
      .map((row) => ({
        providerId: row.provider_id,
        providerName: row.provider_name,
        dialect: row.provider_dialect,
        requests: row.requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        estimatedCostUsd: row.estimated_cost_usd,
      }));
  }

  /**
   * Everything the gateway-path gate needs in one read: the day's tokens, the month's estimate and
   * the estimate since `estimateSinceMs` (bucket containing it included, so the overlap errs
   * toward counting). Reads at most one month row and the retained buckets in the window.
   */
  async getGatewayAdmissionSnapshot(
    dateKey: string,
    monthKey: string,
    estimateSinceMs: number | null
  ): Promise<GatewayAdmissionSnapshot> {
    const budget = this.readBudget(dateKey);
    const month = this.sql
      .exec<{ estimated_cost_usd: number }>(
        `SELECT estimated_cost_usd FROM ai_cost_estimate_month WHERE budget_month = ?`,
        monthKey
      )
      .toArray()[0];
    let estimateSinceUsd = 0;
    if (estimateSinceMs !== null) {
      const since = this.sql
        .exec<{ total: number | null }>(
          `SELECT SUM(estimated_cost_usd) AS total FROM ai_cost_estimate_bucket
           WHERE bucket_start >= ?`,
          Math.floor(estimateSinceMs / COST_ESTIMATE_BUCKET_MS) * COST_ESTIMATE_BUCKET_MS
        )
        .toArray()[0];
      estimateSinceUsd = finiteNonNegative(since?.total);
    }
    return {
      budget,
      estimateMonthUsd: finiteNonNegative(month?.estimated_cost_usd),
      estimateSinceUsd,
    };
  }

  private recordCostEstimate(estimate: CostEstimateWrite): void {
    if (!(estimate.costUsd > 0) || !Number.isFinite(estimate.costUsd)) return;
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO ai_cost_estimate_bucket (bucket_start, estimated_cost_usd, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(bucket_start) DO UPDATE SET
         estimated_cost_usd = ai_cost_estimate_bucket.estimated_cost_usd + excluded.estimated_cost_usd,
         updated_at = excluded.updated_at`,
      estimate.bucketStartMs,
      estimate.costUsd,
      now
    );
    this.sql.exec(
      `INSERT INTO ai_cost_estimate_month (budget_month, estimated_cost_usd, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(budget_month) DO UPDATE SET
         estimated_cost_usd = ai_cost_estimate_month.estimated_cost_usd + excluded.estimated_cost_usd,
         updated_at = excluded.updated_at`,
      estimate.monthKey,
      estimate.costUsd,
      now
    );
    // Bounded retention: buckets past the window any gateway total can still need, and months
    // before the current one (both a WHERE-scoped DELETE).
    this.sql.exec(
      `DELETE FROM ai_cost_estimate_bucket WHERE bucket_start < ?`,
      estimate.pruneBeforeMs
    );
    this.sql.exec(`DELETE FROM ai_cost_estimate_month WHERE budget_month < ?`, estimate.monthKey);
  }

  private readBudget(dateKey: string): TokenBudget {
    const row = this.sql
      .exec<{ input_tokens: number; output_tokens: number }>(
        `SELECT input_tokens, output_tokens
         FROM ai_token_budget
         WHERE budget_date = ?`,
        dateKey
      )
      .toArray()[0];

    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
    };
  }
}

function finiteNonNegative(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
