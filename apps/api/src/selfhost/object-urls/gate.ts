/**
 * The box-wide limit on concurrent object uploads (`BoxUploadGate`, one instance per box).
 *
 * Why a limit: celld streams an upload into the R2 binding without holding it in the isolate, but
 * every in-flight upload still costs process memory. Measured on celld v0.6.3 with 1 GB bodies
 * (task tasks/active/2026-11-23-selfhost-box-object-uploads.md): peak RSS 220 MB for one upload,
 * 284 / 427 / 896 MB for 2 / 4 / 8 at once, so roughly 85 MB per upload over a ~150 MB base, while
 * aggregate throughput stops growing after two (~180 MB/s). The default of 4 keeps the peak near
 * 430 MB. An upload over the limit is refused with 503 and Retry-After rather than queued. One
 * uploader (a workspace, else a user) may hold only part of the slots, and the route drops an
 * upload that stops sending bytes (`route.ts`), so a slow or stalled client cannot keep the box's
 * uploads blocked.
 *
 * Why a Durable Object: the limit must hold across every Worker isolate celld runs, and a single
 * object is the box's one serialization point. Each acquire is a lease with a short expiry that the
 * route renews while bytes keep arriving, so a handler that dies without releasing (celld restart,
 * a killed isolate) frees its slot within one lease instead of holding it forever. `acquire` and `release` do all their work in synchronous SQL with
 * no `await`, so two calls cannot interleave inside one (rule 45).
 */
import { DurableObject } from 'cloudflare:workers';

export interface BoxUploadGateEnv {
  BOX_UPLOAD_GATE?: DurableObjectNamespace;
}

export type BoxUploadLease =
  { granted: true } | { granted: false; active: number; retryAfterSeconds: number };

/** Shortest and longest Retry-After hint (seconds) a refusal suggests. */
const MIN_RETRY_AFTER_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 60;

export class BoxUploadGate extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS upload_leases (id TEXT PRIMARY KEY, uploader TEXT NOT NULL, expires_at INTEGER NOT NULL)'
    );
  }

  /**
   * Grants a lease to `id` while fewer than `limits.total` unexpired leases exist on the box and
   * fewer than `limits.perUploader` belong to `uploader`, so one uploader cannot hold every slot.
   */
  /** The gate's clock (a method, not an RPC argument, so no caller can move it). */
  protected now(): number {
    return Date.now();
  }

  acquire(
    id: string,
    uploader: string,
    limits: { total: number; perUploader: number; leaseMs: number }
  ): BoxUploadLease {
    const now = this.now();
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM upload_leases WHERE expires_at <= ?', now);
    const row = sql
      .exec<{ active: number; mine: number; next: number | null }>(
        'SELECT COUNT(*) AS active, COALESCE(SUM(uploader = ?), 0) AS mine, MIN(expires_at) AS next FROM upload_leases',
        uploader
      )
      .one();
    if (row.active >= limits.total || row.mine >= limits.perUploader) {
      // A hint, not a promise: most leases end when their upload finishes, long before expiry.
      const untilExpiry = Math.ceil(((row.next ?? now) - now) / 1000);
      const retryAfterSeconds = Math.min(
        MAX_RETRY_AFTER_SECONDS,
        Math.max(MIN_RETRY_AFTER_SECONDS, untilExpiry)
      );
      return { granted: false, active: row.active, retryAfterSeconds };
    }
    sql.exec(
      'INSERT OR REPLACE INTO upload_leases (id, uploader, expires_at) VALUES (?, ?, ?)',
      id,
      uploader,
      now + limits.leaseMs
    );
    return { granted: true };
  }

  /** Extends a held lease while its upload is still receiving bytes (route.ts). */
  renew(id: string, leaseMs: number): void {
    this.ctx.storage.sql.exec(
      'UPDATE upload_leases SET expires_at = ? WHERE id = ?',
      this.now() + leaseMs,
      id
    );
  }

  release(id: string): void {
    this.ctx.storage.sql.exec('DELETE FROM upload_leases WHERE id = ?', id);
  }
}

/** The box's one gate instance. */
export const BOX_UPLOAD_GATE_NAME = 'box';

interface BoxUploadGateStub {
  acquire(
    id: string,
    uploader: string,
    limits: { total: number; perUploader: number; leaseMs: number }
  ): Promise<BoxUploadLease>;
  renew(id: string, leaseMs: number): Promise<void>;
  release(id: string): Promise<void>;
}

export function boxUploadGate(env: BoxUploadGateEnv): BoxUploadGateStub | null {
  const namespace = env.BOX_UPLOAD_GATE;
  if (!namespace) return null;
  // Typed RPC stub: Cloudflare's generated stub type cannot express this class's methods.
  return namespace.get(namespace.idFromName(BOX_UPLOAD_GATE_NAME)) as unknown as BoxUploadGateStub;
}
