import * as v from 'valibot';

import type { Env } from '../env';
import { resolveD1BindingIdentity } from '../lib/d1-session';
import type { AdminSettingName } from './admin-settings-registry';
import { DEFAULT_CONFIG_READ_TIMEOUT_MS } from './config-read-deadline';
import { withDeadline } from './fetch-timeout';

/** Safety ceiling, not a deploy-time tunable: no instance may hide edits longer than this. */
export const ADMIN_SETTINGS_CACHE_MAX_MS = 60_000;

export interface AdminSettingOverrideRow {
  key: string;
  value: string;
  updatedAt: string;
  updatedBy: string | null;
}

export class AdminSettingsUnavailableError extends Error {
  constructor() {
    // D1 errors can contain SQL parameters. Never propagate them to admin responses or logs.
    super('Admin settings are unavailable; retry after the database recovers.');
    this.name = 'AdminSettingsUnavailableError';
  }
}

interface BindingCache {
  generation: number;
  snapshot?: { rows: AdminSettingOverrideRow[]; startedAt: number; expiresAt: number };
  inFlight?: {
    generation: number;
    startedAt: number;
    deadlineAt: number;
    promise: Promise<AdminSettingOverrideRow[]>;
  };
}

const overrideRowsSchema = v.array(
  v.object({
    key: v.string(),
    value: v.string(),
    updatedAt: v.string(),
    updatedBy: v.nullable(v.string()),
  })
);

async function loadOverrides(database: D1Database): Promise<AdminSettingOverrideRow[]> {
  const result = await database
    .prepare(
      'SELECT key, value, updated_at AS updatedAt, updated_by AS updatedBy FROM platform_settings'
    )
    .all<unknown>();
  // Do not retain validation issues: they can contain settings values. The object
  // schema also strips unexpected fields before rows enter the cache.
  const parsed = v.safeParse(overrideRowsSchema, result.results);
  if (!result.success || !parsed.success) throw new AdminSettingsUnavailableError();
  return parsed.output;
}

/**
 * Persisted overrides only: resolve legacy environment values per call, outside this cache.
 * Secret plaintext never belongs in platform_settings or these snapshots.
 *
 * A writer invalidates its stable D1 binding after the atomic commit (also after ambiguous
 * failures). Other instances may retain their snapshot until TTL. Expired snapshots are
 * NEVER served on failure: consumers must explicitly apply their safe outage policy.
 */
export class AdminSettingsCache {
  private bindings = new WeakMap<D1Database, BindingCache>();
  private resetGeneration = 0;
  private readonly ttlMs: number;

  constructor(
    ttlMs = ADMIN_SETTINGS_CACHE_MAX_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly load: (
      database: D1Database
    ) => Promise<AdminSettingOverrideRow[]> = loadOverrides
  ) {
    this.ttlMs =
      Number.isFinite(ttlMs) && ttlMs >= 0
        ? Math.min(ttlMs, ADMIN_SETTINGS_CACHE_MAX_MS)
        : ADMIN_SETTINGS_CACHE_MAX_MS;
  }

  private state(database: D1Database): BindingCache {
    const identity = resolveD1BindingIdentity(database);
    let state = this.bindings.get(identity);
    if (!state) {
      state = { generation: 0 };
      this.bindings.set(identity, state);
    }
    return state;
  }

  invalidate(database: D1Database): void {
    const state = this.state(database);
    state.generation += 1;
    delete state.snapshot;
    delete state.inFlight;
  }

  resetForTest(): void {
    this.resetGeneration += 1;
    this.bindings = new WeakMap();
  }

  /** Fresh admin reads bypass snapshots; all reads retain the mutation-generation fence. */
  async read(
    database: D1Database,
    fresh = false,
    maxAgeMs = this.ttlMs,
    readTimeoutMs = DEFAULT_CONFIG_READ_TIMEOUT_MS
  ): Promise<AdminSettingOverrideRow[]> {
    const ttlMs =
      Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? Math.min(maxAgeMs, this.ttlMs) : this.ttlMs;
    const useCache = !fresh && ttlMs > 0;
    const state = this.state(database);
    // A request facade may have anchored before an admin commit. Retrying that session
    // after invalidation cannot prove it has seen the write. Load through the raw primary
    // binding so a new generation never republishes an older session snapshot.
    const primary = resolveD1BindingIdentity(database);
    // Bound repeated invalidation races. Never return an obsolete pre-save result to its caller.
    const resetGeneration = this.resetGeneration;
    const maxReadAttempts = 3;
    for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
      const attemptGeneration = state.generation;
      const rows = await this.readAttempt(primary, state, useCache, ttlMs, readTimeoutMs);
      if (this.resetGeneration !== resetGeneration) throw new AdminSettingsUnavailableError();
      if (state.generation !== attemptGeneration) continue;
      if (rows) return rows;
    }
    throw new AdminSettingsUnavailableError();
  }
  private liveSnapshot(state: BindingCache, useCache: boolean, ttlMs: number) {
    if (!useCache || !state.snapshot) return undefined;
    const expiresAt = Math.min(state.snapshot.expiresAt, state.snapshot.startedAt + ttlMs);
    if (this.now() >= expiresAt) return undefined;
    return structuredClone(state.snapshot.rows);
  }

  private flight(
    primary: D1Database,
    state: BindingCache,
    useCache: boolean,
    readTimeoutMs: number
  ) {
    const existing = useCache ? state.inFlight : undefined;
    if (existing?.generation === state.generation && this.now() < existing.deadlineAt)
      return existing;
    const flight = {
      generation: state.generation,
      startedAt: this.now(),
      deadlineAt: this.now() + readTimeoutMs,
      promise: withDeadline(() => this.load(primary), readTimeoutMs),
    };
    if (useCache) state.inFlight = flight;
    return flight;
  }

  /** Undefined means invalidated during this attempt; the bounded outer loop retries. */
  private async readAttempt(
    primary: D1Database,
    state: BindingCache,
    useCache: boolean,
    ttlMs: number,
    readTimeoutMs: number
  ) {
    const snapshot = this.liveSnapshot(state, useCache, ttlMs);
    if (snapshot) return snapshot;
    const flight = this.flight(primary, state, useCache, readTimeoutMs);
    try {
      const rows = await flight.promise;
      if (state.generation !== flight.generation) return undefined;
      if (useCache && state.inFlight !== flight) {
        if (state.inFlight || state.snapshot) return undefined;
        throw new AdminSettingsUnavailableError();
      }
      // Slow responses cannot extend freshness beyond the start of their read.
      if (this.now() >= flight.deadlineAt || (ttlMs > 0 && this.now() >= flight.startedAt + ttlMs))
        throw new AdminSettingsUnavailableError();
      if (useCache)
        state.snapshot = {
          rows: structuredClone(rows),
          startedAt: flight.startedAt,
          expiresAt: flight.startedAt + ttlMs,
        };
      return structuredClone(rows);
    } catch {
      if (state.generation !== flight.generation) return undefined;
      if (useCache && state.inFlight !== flight) {
        if (state.inFlight || state.snapshot) return undefined;
        throw new AdminSettingsUnavailableError();
      }
      if (useCache && state.inFlight === flight) delete state.snapshot;
      throw new AdminSettingsUnavailableError();
    } finally {
      if (state.inFlight === flight) delete state.inFlight;
    }
  }
}

export const LEGACY_KV_CACHE_MAX_MS = 30_000;
function isOperationalSetting(name: AdminSettingName): boolean {
  return name === 'operations.cronSweepsEnabled' || name === 'operations.doAlarmsEnabled';
}
/** Honor shorter legacy convergence windows, including zero, within the safety ceiling. */
export function adminSettingCacheMs(env: Env, name: AdminSettingName): number {
  // A long-lived SamSession must observe an installation stop before its next effect.
  if (name === 'operations.samOperatorDisabled') return 0;
  const ceiling =
    name === 'trials.enabled' ||
    name === 'operations.cronSweepsEnabled' ||
    name === 'operations.doAlarmsEnabled'
      ? LEGACY_KV_CACHE_MAX_MS
      : ADMIN_SETTINGS_CACHE_MAX_MS;
  let raw: string | undefined;
  if (name.startsWith('integration.')) raw = env.PLATFORM_CONFIG_CACHE_MS;
  else if (name === 'trials.enabled') raw = env.TRIAL_KILL_SWITCH_CACHE_MS;
  else if (isOperationalSetting(name)) raw = env.CONTROL_LOOP_KILL_SWITCH_CACHE_MS;
  let configured = ceiling;
  if (raw !== undefined) {
    configured = isOperationalSetting(name) ? Number.parseInt(raw, 10) : Number(raw);
  }
  return Number.isFinite(configured) && configured >= 0 ? Math.min(configured, ceiling) : ceiling;
}
