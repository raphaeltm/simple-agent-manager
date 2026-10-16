import type { BootLogEntry } from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import type { Env } from '../env';

const StoredEntry = v.object({
  step: v.string(),
  status: v.picklist(['started', 'completed', 'failed']),
  message: v.string(),
  detail: v.optional(v.string()),
  timestamp: v.string(),
});

function payload(entry: BootLogEntry): string {
  return JSON.stringify({
    step: entry.step,
    status: entry.status,
    message: entry.message,
    detail: entry.detail,
    timestamp: entry.timestamp,
  });
}

/** Per-workspace append storage. A durable marker prevents cleared legacy logs resurfacing. */
export class WorkspaceBootLog extends DurableObject<Env> {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS log_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), expires_at INTEGER NOT NULL, allow_legacy INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL UNIQUE
    )`);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private state(): { expires_at: number; allow_legacy: number } | undefined {
    return this.ctx.storage.sql
      .exec<{ expires_at: number; allow_legacy: number }>(
        'SELECT expires_at, allow_legacy FROM log_state WHERE id = 1'
      )
      .toArray()[0];
  }

  private expire(): void {
    const state = this.state();
    if (state && state.expires_at <= Date.now()) {
      this.ctx.storage.sql.exec('DELETE FROM entries');
      this.ctx.storage.sql.exec('UPDATE log_state SET allow_legacy = 0 WHERE id = 1');
    }
  }

  private trim(maxEntries: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM entries WHERE sequence NOT IN
      (SELECT sequence FROM entries ORDER BY sequence DESC LIMIT ?)`,
      maxEntries
    );
  }

  private insert(entry: BootLogEntry): void {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO entries(payload) VALUES (?)', payload(entry));
  }

  async read(workspaceId: string, maxEntries: number): Promise<BootLogEntry[]> {
    return this.withLock(async () => {
      this.expire();
      const state = this.state();
      // Read compatibility, not a one-time import: propagation can reveal a late KV
      // write after the first post-cutover read. Legacy keys expire naturally.
      const legacy =
        !state || state.allow_legacy
          ? ((await this.env.KV.get<unknown>(`bootlog:${workspaceId}`, { type: 'json' })) ?? [])
          : [];
      const old = v.parse(v.array(StoredEntry), legacy).slice(-maxEntries);
      const current = this.ctx.storage.sql
        .exec<{ payload: string }>('SELECT payload FROM entries ORDER BY sequence')
        .toArray()
        .map((row) => v.parse(StoredEntry, JSON.parse(row.payload)));
      const unique = new Map<string, BootLogEntry>();
      for (const entry of [...old, ...current]) {
        const key = payload(entry);
        unique.delete(key);
        unique.set(key, entry);
      }
      return [...unique.values()].slice(-maxEntries);
    });
  }

  async append(entry: BootLogEntry, ttl: number, maxEntries: number): Promise<void> {
    return this.withLock(async () => {
      const expiresAt = Date.now() + ttl * 1000;
      await this.ctx.storage.setAlarm(expiresAt);
      this.ctx.storage.transactionSync(() => {
        this.expire();
        this.insert(entry);
        this.trim(maxEntries);
        this.ctx.storage.sql.exec(
          `INSERT INTO log_state VALUES (1, ?, 1)
          ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at`,
          expiresAt
        );
      });
    });
  }

  async replace(logs: BootLogEntry[], ttl: number, maxEntries: number): Promise<void> {
    return this.withLock(async () => {
      const expiresAt = Date.now() + ttl * 1000;
      await this.ctx.storage.setAlarm(expiresAt);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM entries');
        for (const entry of logs.slice(-maxEntries)) this.insert(entry);
        this.ctx.storage.sql.exec(
          `INSERT INTO log_state VALUES (1, ?, 0)
          ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, allow_legacy = 0`,
          expiresAt
        );
      });
    });
  }

  async alarm(): Promise<void> {
    return this.withLock(async () => {
      this.expire();
      const state = this.state();
      if (state && state.expires_at > Date.now()) await this.ctx.storage.setAlarm(state.expires_at);
      // Keep one bounded marker; legacy data must never be re-imported after clear/expiry.
    });
  }
}
