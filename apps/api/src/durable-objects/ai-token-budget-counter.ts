import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import type {
  AiProviderUsageAttribution,
  AiProviderUsageEntry,
  TokenBudget,
} from '../services/ai-token-budget';

export class AiTokenBudgetCounter extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
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
    });
  }

  async get(dateKey: string): Promise<TokenBudget> {
    return this.readBudget(dateKey);
  }

  async increment(
    dateKey: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<TokenBudget> {
    return this.ctx.storage.transactionSync(() => {
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
        Date.now(),
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
  ): Promise<void> {
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
        Date.now(),
      );
    });
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
        startDateKey,
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

  private readBudget(dateKey: string): TokenBudget {
    const row = this.sql
      .exec<{ input_tokens: number; output_tokens: number }>(
        `SELECT input_tokens, output_tokens
         FROM ai_token_budget
         WHERE budget_date = ?`,
        dateKey,
      )
      .toArray()[0];

    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
    };
  }
}
