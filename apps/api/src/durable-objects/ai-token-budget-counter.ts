import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import type { TokenBudget } from '../services/ai-token-budget';

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
