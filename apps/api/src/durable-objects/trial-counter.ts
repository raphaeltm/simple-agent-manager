/**
 * TrialCounter — global singleton Durable Object for enforcing the monthly
 * trial cap.
 *
 * Keyed by the literal string `global` (one instance per deployment). Callers
 * compute the current month key (`YYYY-MM` UTC) and ask the DO to increment
 * or decrement the counter atomically.
 *
 * Storage: embedded SQLite (see wrangler.toml migration tag v7 —
 * `new_sqlite_classes = ["TrialCounter"]`). Atomicity is guaranteed by
 * `this.ctx.storage.transactionSync` — all reads and writes within the
 * callback commit together.
 *
 * Accessed via:
 *   const stub = env.TRIAL_COUNTER.get(env.TRIAL_COUNTER.idFromName('global'));
 *   const result = await stub.increment(monthKey, cap);
 */
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';

export interface TrialCounterIncrementResult {
  /** true when the increment succeeded (count <= cap after increment) */
  ok: boolean;
  /** count after the operation (or current count when cap was hit) */
  count: number;
}

export interface TrialCounterState {
  monthKey: string;
  count: number;
}

export class TrialCounter extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS trial_counter (
          month_key TEXT PRIMARY KEY NOT NULL,
          count     INTEGER NOT NULL DEFAULT 0
        )`
      );
    });
  }

  /**
   * Atomically increment the counter for `monthKey` by 1 and return the new
   * value. If the increment would exceed `cap`, the counter is NOT incremented
   * and `{ ok: false, count }` is returned. `cap <= 0` disables the limit.
   */
  async increment(
    monthKey: string,
    cap: number
  ): Promise<TrialCounterIncrementResult> {
    return this.ctx.storage.transactionSync(() => {
      const current = this.readCount(monthKey);
      if (cap > 0 && current >= cap) {
        return { ok: false, count: current };
      }
      const next = current + 1;
      this.sql.exec(
        `INSERT INTO trial_counter (month_key, count) VALUES (?, ?)
         ON CONFLICT(month_key) DO UPDATE SET count = excluded.count`,
        monthKey,
        next
      );
      return { ok: true, count: next };
    });
  }

  /**
   * Decrement the counter for `monthKey`. Used when a trial fails AFTER slot
   * allocation (so the slot isn't "burned" by a failed provision). Clamps at 0.
   */
  async decrement(monthKey: string): Promise<number> {
    return this.ctx.storage.transactionSync(() => {
      const current = this.readCount(monthKey);
      const next = Math.max(0, current - 1);
      this.sql.exec(
        `INSERT INTO trial_counter (month_key, count) VALUES (?, ?)
         ON CONFLICT(month_key) DO UPDATE SET count = excluded.count`,
        monthKey,
        next
      );
      return next;
    });
  }

  /** Read-only accessor for the cap/available display in the UI. */
  async get(monthKey: string): Promise<TrialCounterState> {
    const count = this.readCount(monthKey);
    return { monthKey, count };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private readCount(monthKey: string): number {
    const row = this.sql
      .exec<{ count: number }>(
        'SELECT count FROM trial_counter WHERE month_key = ? LIMIT 1',
        monthKey
      )
      .toArray()[0];
    return row?.count ?? 0;
  }
}
