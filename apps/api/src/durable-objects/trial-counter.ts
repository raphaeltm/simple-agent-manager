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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface TrialCounterIncrementResult {
  /** true when the increment succeeded (count <= cap after increment) */
  ok: boolean;
  /** count after the operation (or current count when cap was hit) */
  count: number;
}

/**
 * Public shape for the Wave-1 fetch API — identical semantics to
 * {@link TrialCounterIncrementResult} but uses `allowed` to match the
 * HTTP contract documented for the trial create endpoint.
 */
export interface TrialCounterTryIncrementResult {
  allowed: boolean;
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

  /**
   * Thin alias around {@link increment} that returns the
   * `{ allowed, count }` shape used by the Wave-1 HTTP contract. Kept
   * separate so call sites that speak the HTTP vocabulary don't have to
   * translate `ok` -> `allowed` themselves.
   */
  async tryIncrement(
    monthKey: string,
    cap: number
  ): Promise<TrialCounterTryIncrementResult> {
    const result = await this.increment(monthKey, cap);
    return { allowed: result.ok, count: result.count };
  }

  /**
   * Delete counter rows whose month keys predate `keepMonthKey` (inclusive
   * of `keepMonthKey` is kept). Returns the number of rows deleted. Used
   * by the monthly rollover audit cron to bound the DO's SQLite growth.
   */
  async prune(keepMonthKey: string): Promise<number> {
    return this.ctx.storage.transactionSync(() => {
      const before = this.sql
        .exec<{ c: number }>(
          'SELECT COUNT(*) AS c FROM trial_counter WHERE month_key < ?',
          keepMonthKey
        )
        .toArray()[0]?.c ?? 0;
      this.sql.exec(
        'DELETE FROM trial_counter WHERE month_key < ?',
        keepMonthKey
      );
      return before;
    });
  }

  /** Read-only accessor for the cap/available display in the UI. */
  async get(monthKey: string): Promise<TrialCounterState> {
    const count = this.readCount(monthKey);
    return { monthKey, count };
  }

  /**
   * Minimal HTTP surface for the DO. Supports:
   *   GET  /state?monthKey=YYYY-MM     -> { monthKey, count }
   *   POST /tryIncrement               -> { allowed, count }
   *     body: { monthKey: string, cap: number }
   *   POST /decrement                  -> { count }
   *     body: { monthKey: string }
   *   POST /prune                      -> { deleted }
   *     body: { keepMonthKey: string }
   *
   * The fetch handler is useful for Wave-1 call sites that cannot use
   * DO RPC directly (e.g. cross-service debug tooling); routes that run
   * in the same Worker bundle SHOULD use the typed RPC methods above.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/state') {
        const monthKey = url.searchParams.get('monthKey');
        if (!monthKey) return jsonResponse({ error: 'monthKey required' }, 400);
        const state = await this.get(monthKey);
        return jsonResponse(state, 200);
      }

      if (request.method === 'POST' && url.pathname === '/tryIncrement') {
        const body = (await request.json()) as {
          monthKey?: string;
          cap?: number;
        };
        if (!body.monthKey || typeof body.cap !== 'number') {
          return jsonResponse({ error: 'monthKey + cap required' }, 400);
        }
        const result = await this.tryIncrement(body.monthKey, body.cap);
        return jsonResponse(result, 200);
      }

      if (request.method === 'POST' && url.pathname === '/decrement') {
        const body = (await request.json()) as { monthKey?: string };
        if (!body.monthKey) return jsonResponse({ error: 'monthKey required' }, 400);
        const count = await this.decrement(body.monthKey);
        return jsonResponse({ count }, 200);
      }

      if (request.method === 'POST' && url.pathname === '/prune') {
        const body = (await request.json()) as { keepMonthKey?: string };
        if (!body.keepMonthKey) {
          return jsonResponse({ error: 'keepMonthKey required' }, 400);
        }
        const deleted = await this.prune(body.keepMonthKey);
        return jsonResponse({ deleted }, 200);
      }

      return jsonResponse({ error: 'not_found' }, 404);
    } catch (err) {
      return jsonResponse(
        {
          error: 'internal',
          message: err instanceof Error ? err.message : String(err),
        },
        500
      );
    }
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
