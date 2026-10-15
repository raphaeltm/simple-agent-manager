import type { BootLogEntry } from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import type { Env } from '../env';
import { readStorageActivation } from '../services/reliability-storage';

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
    return this.withLock(() => this.readUnlocked(workspaceId, maxEntries));
  }

  private async readUnlocked(workspaceId: string, maxEntries: number): Promise<BootLogEntry[]> {
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
  }

  async append(entry: BootLogEntry, ttl: number, maxEntries: number): Promise<void> {
    return this.withLock(() => this.appendUnlocked(entry, ttl, maxEntries));
  }

  private async appendUnlocked(
    entry: BootLogEntry,
    ttl: number,
    maxEntries: number
  ): Promise<void> {
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
  }

  async replace(logs: BootLogEntry[], ttl: number, maxEntries: number): Promise<void> {
    return this.withLock(() => this.replaceUnlocked(logs, ttl, maxEntries));
  }

  private async replaceUnlocked(
    logs: BootLogEntry[],
    ttl: number,
    maxEntries: number
  ): Promise<void> {
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
  }

  private async usesSQLite(): Promise<boolean> {
    const activation = await readStorageActivation(this.env.DATABASE);
    return activation !== null && Math.floor(Date.now() / 1000) >= activation.bootLogCutoverAt;
  }

  async readBridge(workspaceId: string, maxEntries: number): Promise<BootLogEntry[]> {
    return this.withLock(async () => {
      if ((await this.usesSQLite()) || this.state()?.allow_legacy === 0)
        return this.readUnlocked(workspaceId, maxEntries);
      return (
        (await this.env.KV.get<BootLogEntry[]>(`bootlog:${workspaceId}`, { type: 'json' })) ?? []
      );
    });
  }

  async appendBridge(
    workspaceId: string,
    entry: BootLogEntry,
    ttl: number,
    maxEntries: number
  ): Promise<void> {
    return this.withLock(async () => {
      if (await this.usesSQLite()) return this.appendUnlocked(entry, ttl, maxEntries);
      // A replacement establishes ordering even before activation. Preserve later
      // bridge appends in the same durable view rather than reimporting stale KV.
      if (this.state()?.allow_legacy === 0) {
        await this.appendUnlocked(entry, ttl, maxEntries);
        await this.env.KV.put(`bootlog:${workspaceId}`, JSON.stringify(await this.readUnlocked(workspaceId, maxEntries)), {expirationTtl: ttl});
        return;
      }
      const existing =
        (await this.env.KV.get<BootLogEntry[]>(`bootlog:${workspaceId}`, { type: 'json' })) ?? [];
      await this.env.KV.put(
        `bootlog:${workspaceId}`,
        JSON.stringify([...existing, entry].slice(-maxEntries)),
        { expirationTtl: ttl }
      );
    });
  }

  async replaceBridge(
    workspaceId: string,
    logs: BootLogEntry[],
    ttl: number,
    maxEntries: number
  ): Promise<void> {
    return this.withLock(async () => {
      const activated = await this.usesSQLite();
      // Persist the clear/replacement fence before the eventually-consistent KV
      // mirror, so cutover/restart cannot resurrect the pre-replacement tail.
      await this.replaceUnlocked(logs, ttl, maxEntries);
      if (activated) return;
      await this.env.KV.put(`bootlog:${workspaceId}`, JSON.stringify(logs.slice(-maxEntries)), {
        expirationTtl: ttl,
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
