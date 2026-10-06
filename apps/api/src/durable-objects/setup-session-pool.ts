/**
 * SetupSessionPool — global singleton Durable Object that gates the number of
 * concurrent guided credential-setup sandbox sessions.
 *
 * Keyed by the literal string `global` (one instance per deployment). Every
 * setup session must lease a slot before provisioning a Cloudflare Sandbox and
 * MUST release it on teardown. The Sandbox container pool is shared platform-
 * wide (wrangler `max_instances`), so this sub-cap prevents credential-setup
 * from starving other container features.
 *
 * Storage: embedded SQLite (wrangler migration `new_sqlite_classes`). Atomicity
 * is guaranteed by `ctx.storage.transactionSync` — the read-check-write in
 * `lease()` commits as one unit, so two concurrent leases cannot both see room
 * under the cap (rule 45: never rely on DO single-threading across `await`).
 *
 * Leaked-lease self-heal: a session whose DO dies without releasing would
 * otherwise consume a slot forever. `lease()` first prunes leases older than
 * `maxLeaseAgeMs` (session TTL + buffer), so every slot has a guaranteed escape
 * path (rule 47).
 */
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';

export interface LeaseResult {
  granted: boolean;
  leaseId: string | null;
  active: number;
  cap: number;
}

export class SetupSessionPool extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS pool_leases (
          lease_id   TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`
      );
    });
  }

  /**
   * Atomically lease a concurrency slot. Prunes stale (leaked) leases first,
   * then grants only if the active count is below `cap`. `cap <= 0` disables the
   * limit. Returns `granted: false` with the current count when at capacity.
   */
  async lease(sessionId: string, cap: number, maxLeaseAgeMs: number): Promise<LeaseResult> {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.sql.exec('DELETE FROM pool_leases WHERE created_at < ?', now - maxLeaseAgeMs);
      const active = this.count();
      if (cap > 0 && active >= cap) {
        return { granted: false, leaseId: null, active, cap };
      }
      const leaseId = crypto.randomUUID();
      this.sql.exec(
        'INSERT INTO pool_leases (lease_id, session_id, created_at) VALUES (?, ?, ?)',
        leaseId,
        sessionId,
        now
      );
      return { granted: true, leaseId, active: active + 1, cap };
    });
  }

  /** Release a leased slot. Idempotent — releasing an unknown/expired lease is a no-op. */
  async release(leaseId: string): Promise<{ active: number }> {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM pool_leases WHERE lease_id = ?', leaseId);
      return { active: this.count() };
    });
  }

  /** Current number of leased slots (observability). */
  async getActive(): Promise<number> {
    return this.count();
  }

  private count(): number {
    return (
      this.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM pool_leases').toArray()[0]?.c ?? 0
    );
  }
}
