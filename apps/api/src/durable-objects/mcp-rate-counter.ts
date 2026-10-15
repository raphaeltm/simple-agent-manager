import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';

export type McpRateResult =
  | { allowed: true; remaining: number; resetAt: number }
  | { allowed: false; remaining: 0; resetAt: number; retryAfter: number };

/** One object per existing MCP identity. No external I/O in the SQL critical section. */
export class McpRateCounter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS counters (
      window_start INTEGER PRIMARY KEY, reset_at INTEGER NOT NULL, count INTEGER NOT NULL
    )`);
  }

  async consume(windowStart: number, resetAt: number, limit: number): Promise<McpRateResult> {
    const now = Math.floor(Date.now() / 1000);
    if (
      ![windowStart, resetAt, limit].every(Number.isSafeInteger) ||
      windowStart > now ||
      resetAt <= now ||
      resetAt <= windowStart ||
      limit < 1
    ) {
      throw new Error('Invalid MCP counter window');
    }
    // Persist cleanup before acknowledging admission. Failure never falls back to KV.
    await this.ctx.storage.setAlarm(resetAt * 1000);
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM counters WHERE reset_at <= ?', now);
      const row = this.ctx.storage.sql
        .exec<{ count: number }>('SELECT count FROM counters WHERE window_start = ?', windowStart)
        .toArray()[0];
      const count = row?.count ?? 0;
      if (count >= limit) {
        return { allowed: false, remaining: 0, resetAt, retryAfter: Math.max(1, resetAt - now) };
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO counters VALUES (?, ?, ?)
        ON CONFLICT(window_start) DO UPDATE SET count = excluded.count`,
        windowStart,
        resetAt,
        count + 1
      );
      return { allowed: true, remaining: limit - count - 1, resetAt };
    });
  }

  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.sql.exec('DELETE FROM counters WHERE reset_at <= ?', now);
    const next = this.ctx.storage.sql
      .exec<{ next: number | null }>('SELECT MIN(reset_at) AS next FROM counters')
      .toArray()[0]?.next;
    if (next) await this.ctx.storage.setAlarm(next * 1000);
  }
}
