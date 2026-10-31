/** Shared Phase 1 resolver and atomic, value-free audit boundary. */
import type { Env } from '../env';
import { resolveD1BindingIdentity } from '../lib/d1-session';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { errors } from '../middleware/error';
import {
  adminSettingCacheMs,
  AdminSettingsCache,
  AdminSettingsUnavailableError,
  LEGACY_KV_CACHE_MAX_MS,
} from './admin-settings-cache';
import { DecryptedCredentialValues } from './admin-settings-credential-values';
import {
  ADMIN_SETTINGS_REGISTRY,
  type AdminSettingDefinition,
  type AdminSettingName,
  type AdminSettingValue,
  findAdminSetting,
  publicAdminSettingDefinition,
} from './admin-settings-registry';
import { readAdminSettingsSnapshot } from './admin-settings-snapshot';
import { DEFAULT_CONFIG_READ_TIMEOUT_MS } from './config-read-deadline';
import { withDeadline } from './fetch-timeout';
import { INTEGRATION_CREDENTIAL_TYPE } from './platform-config-store';

export function requiredDefinition(name: string): AdminSettingDefinition {
  const def = findAdminSetting(name);
  if (!def) throw errors.badRequest('Unknown admin setting');
  return def;
}
export const cache = new AdminSettingsCache();
let generations = new WeakMap<D1Database, number>();
let generationClock = 0;
let resetGeneration = 0;
function generationOf(db: D1Database): number {
  return generations.get(db) ?? resetGeneration;
}
function assertGeneration(db: D1Database, generation: number): void {
  if (generationOf(db) !== generation) throw new AdminSettingsUnavailableError();
}
export type CredentialRow = {
  provider: string;
  kind: string;
  ciphertext: string;
  iv: string;
  updatedAt: string;
  updatedBy: string | null;
};
const decryptedCredentials = new DecryptedCredentialValues();
let credentialCache = new WeakMap<
  D1Database,
  {
    startedAt: number;
    expiresAt: number;
    deadlineAt: number;
    pending: boolean;
    promise: Promise<CredentialRow[]>;
  }
>();
export async function credentialRows(
  env: Env,
  fresh = false,
  attempt = 0
): Promise<CredentialRow[]> {
  if (attempt >= 3) throw new AdminSettingsUnavailableError();
  const db = resolveD1BindingIdentity(env.DATABASE);
  if (!db || typeof db.prepare !== 'function') throw new AdminSettingsUnavailableError();
  const generation = generationOf(db);
  const ttlMs = adminSettingCacheMs(env, 'integration.github.clientSecret');
  const useCache = !fresh && ttlMs > 0;
  const existing = credentialCache.get(db);
  if (
    useCache &&
    existing &&
    (!existing.pending || Date.now() < existing.deadlineAt) &&
    Math.min(existing.expiresAt, existing.startedAt + ttlMs) > Date.now()
  ) {
    const rows = await existing.promise;
    if (credentialCache.get(db) !== existing) return credentialRows(env, false, attempt + 1);
    assertGeneration(db, generation);
    if (Date.now() >= Math.min(existing.expiresAt, existing.startedAt + ttlMs))
      throw new AdminSettingsUnavailableError();
    return rows;
  }
  const entry = {
    startedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    deadlineAt: Date.now() + DEFAULT_CONFIG_READ_TIMEOUT_MS,
    pending: true,
    promise: withDeadline(
      () =>
        db
          .prepare(
            'SELECT provider,credential_kind AS kind,encrypted_token AS ciphertext,iv,updated_at AS updatedAt,COALESCE(updated_by,created_by) AS updatedBy FROM platform_credentials WHERE credential_type=? AND is_enabled=1 ORDER BY updated_at DESC,created_at DESC'
          )
          .bind(INTEGRATION_CREDENTIAL_TYPE)
          .all<CredentialRow>()
          .then((result) => {
            if (!result.success) throw new AdminSettingsUnavailableError();
            return result.results;
          }),
      DEFAULT_CONFIG_READ_TIMEOUT_MS
    ),
  };
  if (useCache) credentialCache.set(db, entry);
  try {
    const rows = await entry.promise;
    if (useCache && credentialCache.get(db) !== entry)
      return credentialRows(env, false, attempt + 1);
    if (
      generationOf(db) !== generation ||
      Date.now() >= entry.deadlineAt ||
      (ttlMs > 0 && Date.now() >= entry.expiresAt)
    )
      throw new AdminSettingsUnavailableError();
    entry.pending = false;
    return rows;
  } catch {
    if (credentialCache.get(db) === entry) credentialCache.delete(db);
    throw new AdminSettingsUnavailableError();
  }
}
let kvCache = new WeakMap<
  D1Database,
  Map<
    string,
    {
      startedAt: number;
      expiresAt: number;
      deadlineAt: number;
      pending: boolean;
      promise: Promise<string | null>;
    }
  >
>();
type KvReads = ReadonlyMap<string, Promise<{ value: string | null } | { error: unknown }>>;
async function legacyKv(
  env: Env,
  key: string,
  fresh: boolean,
  ttlMs = LEGACY_KV_CACHE_MAX_MS,
  attempt = 0,
  preloaded?: KvReads
) {
  const pending = preloaded?.get(key);
  if (pending) {
    const result = await pending;
    if ('error' in result) throw result.error;
    return result.value;
  }
  if (attempt >= 3) throw new AdminSettingsUnavailableError();
  const db = resolveD1BindingIdentity(env.DATABASE);
  const generation = generationOf(db);
  let map = kvCache.get(db);
  if (!map) {
    map = new Map();
    kvCache.set(db, map);
  }
  const useCache = !fresh && ttlMs > 0;
  const cached = map.get(key);
  if (
    useCache &&
    cached &&
    (!cached.pending || Date.now() < cached.deadlineAt) &&
    Math.min(cached.expiresAt, cached.startedAt + ttlMs) > Date.now()
  ) {
    const value = await cached.promise;
    if (map.get(key) !== cached) return legacyKv(env, key, false, ttlMs, attempt + 1);
    if (
      generationOf(db) !== generation ||
      Date.now() >= Math.min(cached.expiresAt, cached.startedAt + ttlMs)
    )
      throw new AdminSettingsUnavailableError();
    return value;
  }
  const entry = {
    startedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    deadlineAt: Date.now() + DEFAULT_CONFIG_READ_TIMEOUT_MS,
    pending: true,
    promise: withDeadline(() => env.KV.get(key), DEFAULT_CONFIG_READ_TIMEOUT_MS),
  };
  if (useCache) map.set(key, entry);
  try {
    const value = await entry.promise;
    if (useCache && map.get(key) !== entry) return legacyKv(env, key, false, ttlMs, attempt + 1);
    if (
      generationOf(db) !== generation ||
      Date.now() >= entry.deadlineAt ||
      (ttlMs > 0 && Date.now() >= entry.expiresAt)
    )
      throw new AdminSettingsUnavailableError();
    entry.pending = false;
    return value;
  } catch {
    if (map.get(key) === entry) map.delete(key);
    throw new AdminSettingsUnavailableError();
  }
}
let disabled = new WeakMap<D1Database, Set<string>>();
/** Compatibility test seam; outstanding reads retain a distinct generation and must fail. */
export function __resetAdminSettingsCacheForTest(): void {
  decryptedCredentials.clear();
  resetGeneration = ++generationClock;
  generations = new WeakMap();
  credentialCache = new WeakMap();
  kvCache = new WeakMap();
  disabled = new WeakMap();
  cache.resetForTest();
}
export function invalidateAdminSettings(env: Env): void {
  const db = resolveD1BindingIdentity(env.DATABASE);
  generations.set(db, ++generationClock);
  cache.invalidate(env.DATABASE);
  credentialCache.delete(resolveD1BindingIdentity(env.DATABASE));
  kvCache.delete(resolveD1BindingIdentity(env.DATABASE));
}
function observe(env: Env, name: string, value: AdminSettingValue): void {
  const db = resolveD1BindingIdentity(env.DATABASE);
  let values = disabled.get(db);
  if (!values) {
    values = new Set();
    disabled.set(db, values);
  }
  if (value === false) values.add(name);
  else values.delete(name);
}
function parseValue(def: AdminSettingDefinition, raw: string): unknown {
  if (def.type === 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return def.type === 'string-list' ? raw.split(',').map((x) => x.trim()) : raw;
  }
}
function operationalKvKey(env: Env, def: AdminSettingDefinition): string | null {
  if (def.legacyKv === 'cron')
    return env.CRON_SWEEPS_ENABLED_KV_KEY ?? 'control-loops:cron-enabled';
  if (def.legacyKv === 'alarms')
    return env.DO_ALARMS_ENABLED_KV_KEY ?? 'control-loops:alarms-enabled';
  return null;
}
async function hasEmergencyVeto(
  env: Env,
  def: AdminSettingDefinition,
  fresh = false,
  kvReads?: KvReads
): Promise<boolean> {
  const key = operationalKvKey(env, def);
  if (!key) return false;
  const value = await legacyKv(env, key, fresh, adminSettingCacheMs(env, def.name), 0, kvReads);
  return value === 'false' || value === 'disabled';
}
export type OverrideRows = Awaited<ReturnType<AdminSettingsCache['read']>>;
function validStoredValue(def: AdminSettingDefinition, value: unknown): boolean {
  // Preserve legacy nonempty OAuth values; stricter validation applies to new edits.
  if (def.category === 'OAuth') return typeof value === 'string' && Boolean(value.trim());
  return def.validate(value);
}
async function credentialDetails(
  env: Env,
  def: AdminSettingDefinition,
  secretValue: boolean,
  credentials?: CredentialRow[]
) {
  const credential = def.credential;
  if (!credential) return null;
  const result = (credentials ?? (await credentialRows(env))).find(
    (row) => row.provider === credential.provider && row.kind === credential.kind
  );
  if (!result) return null;
  return {
    value: secretValue
      ? await decryptedCredentials.read(result, getCredentialEncryptionKey(env))
      : null,
    configured: true,
    source: 'database' as const,
    updatedAt: result.updatedAt,
    updatedBy: result.updatedBy,
  };
}
function kvDetails(env: Env, def: AdminSettingDefinition, value: boolean) {
  observe(env, def.name, value);
  return { value, configured: true, source: 'kv' as const, updatedAt: null, updatedBy: null };
}
async function overrideDetails(
  env: Env,
  def: AdminSettingDefinition,
  rows: OverrideRows,
  fresh: boolean,
  kvReads?: KvReads
) {
  const row = rows.find((row) => row.key === def.name);
  if (!row) return null;
  const value = parseValue(def, row.value);
  if (!validStoredValue(def, value)) throw new AdminSettingsUnavailableError();
  if (value === true && (await hasEmergencyVeto(env, def, fresh, kvReads)))
    return kvDetails(env, def, false);
  observe(env, def.name, value as AdminSettingValue);
  return {
    value: value as AdminSettingValue,
    configured: true,
    source: 'database' as const,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}
function environmentDetails(env: Env, def: AdminSettingDefinition, secretValue: boolean) {
  const raw = def.legacyEnvironment ? env[def.legacyEnvironment] : undefined;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = parseValue(def, raw);
  if (def.category !== 'OAuth' && !def.validate(value)) return null;
  observe(env, def.name, value as AdminSettingValue);
  return {
    value: def.secret && !secretValue ? null : (value as AdminSettingValue),
    configured: true,
    source: 'environment' as const,
    updatedAt: null,
    updatedBy: null,
  };
}
async function legacyKvDetails(
  env: Env,
  def: AdminSettingDefinition,
  fresh: boolean,
  kvReads?: KvReads
) {
  if (!def.legacyKv) return null;
  let key = operationalKvKey(env, def);
  if (def.legacyKv === 'trials') key = env.TRIALS_ENABLED_KV_KEY ?? 'trials:enabled';
  if (!key) return null;
  const value = await legacyKv(env, key, fresh, adminSettingCacheMs(env, def.name), 0, kvReads);
  if (value === null) return null;
  const enabled =
    def.legacyKv === 'trials' ? value === 'true' : value !== 'false' && value !== 'disabled';
  return kvDetails(env, def, enabled);
}
export async function resolved(
  env: Env,
  def: AdminSettingDefinition,
  rows: OverrideRows,
  secretValue: boolean,
  credentials?: CredentialRow[],
  fresh = false,
  kvReads?: KvReads
) {
  const stored = def.credential
    ? await credentialDetails(env, def, secretValue, credentials)
    : await overrideDetails(env, def, rows, fresh, kvReads);
  if (stored) return stored;
  const environment = environmentDetails(env, def, secretValue);
  if (environment) return environment;
  const kv = await legacyKvDetails(env, def, fresh, kvReads);
  if (kv) return kv;
  observe(env, def.name, def.defaultValue);
  return {
    value: def.defaultValue,
    configured: false,
    source: 'default' as const,
    updatedAt: null,
    updatedBy: null,
  };
}
/** Resolve a related group with one row/ciphertext read, including when caching is disabled. */
export async function resolveAdminSettingDetailsMany(
  env: Env,
  names: AdminSettingName[],
  options: { fresh?: boolean } = {}
) {
  const definitions = names.map(requiredDefinition);
  const primary = resolveD1BindingIdentity(env.DATABASE);
  const maxAge = Math.min(...names.map((name) => adminSettingCacheMs(env, name)));
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = generationOf(primary);
    try {
      const [rows, credentials] = await Promise.all([
        cache.read(primary, options.fresh ?? false, maxAge, DEFAULT_CONFIG_READ_TIMEOUT_MS),
        definitions.some((def) => def.credential)
          ? credentialRows(env, options.fresh)
          : Promise.resolve([]),
      ]);
      const values = await Promise.all(
        definitions.map((def) => resolved(env, def, rows, true, credentials))
      );
      if (generationOf(primary) !== generation) continue;
      return values;
    } catch {
      if (generationOf(primary) !== generation) continue;
      throw new AdminSettingsUnavailableError();
    }
  }
  throw new AdminSettingsUnavailableError();
}
export async function resolveAdminSettingDetails(env: Env, name: AdminSettingName) {
  const [setting] = await resolveAdminSettingDetailsMany(env, [name]);
  if (!setting) throw new AdminSettingsUnavailableError();
  return setting;
}
export async function resolveAdminSetting(
  env: Env,
  name: AdminSettingName
): Promise<AdminSettingValue> {
  const def = findAdminSetting(name);
  if (!def) throw errors.badRequest('Unknown admin setting');
  try {
    return (
      await resolved(
        env,
        def,
        await cache.read(
          env.DATABASE,
          false,
          adminSettingCacheMs(env, name),
          DEFAULT_CONFIG_READ_TIMEOUT_MS
        ),
        true
      )
    ).value;
  } catch {
    // Emergency containment remains available independently of D1 health.
    try {
      if (await hasEmergencyVeto(env, def)) {
        observe(env, name, false);
        return false;
      }
    } catch {
      /* Keep the previously observed brake when KV is unavailable too. */
    }
    return outageValue(env, def, name);
  }
}
function outageValue(
  env: Env,
  def: AdminSettingDefinition,
  name: AdminSettingName
): AdminSettingValue {
  // This switch has inverse polarity: true is the safe state on a settings outage.
  if (name === 'operations.samOperatorDisabled') return true;
  if (
    def.legacyEnvironment &&
    typeof env[def.legacyEnvironment] === 'string' &&
    parseValue(def, String(env[def.legacyEnvironment])) === false
  )
    return false;
  if (def.type === 'boolean') {
    if (name.startsWith('connector.') || name === 'trials.enabled') return false;
    return disabled.get(resolveD1BindingIdentity(env.DATABASE))?.has(name)
      ? false
      : def.defaultValue;
  }
  if (name === 'connector.clientRegistration') return 'allowlist';
  if (name === 'connector.allowedRedirectHosts') return [];
  if (def.category === 'OAuth') return null;
  return def.defaultValue;
}
export async function readAdminSettings(env: Env, options: { fresh?: boolean } = {}) {
  const primary = resolveD1BindingIdentity(env.DATABASE);
  try {
    const snapshotPromise = withDeadline(
      () => readAdminSettingsSnapshot(primary),
      DEFAULT_CONFIG_READ_TIMEOUT_MS
    );
    const kvReads = new Map<string, Promise<{ value: string | null } | { error: unknown }>>();
    for (const def of ADMIN_SETTINGS_REGISTRY) {
      const key =
        def.legacyKv === 'trials'
          ? (env.TRIALS_ENABLED_KV_KEY ?? 'trials:enabled')
          : operationalKvKey(env, def);
      if (key && !kvReads.has(key))
        kvReads.set(
          key,
          legacyKv(env, key, options.fresh ?? true, adminSettingCacheMs(env, def.name)).then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
          )
        );
    }
    const snapshot = await snapshotPromise;
    if (snapshot.revision === undefined) throw new AdminSettingsUnavailableError();
    const { rows, credentials } = snapshot;
    const settings = await Promise.all(
      ADMIN_SETTINGS_REGISTRY.map(async (def) => ({
        ...publicAdminSettingDefinition(def),
        ...(await resolved(env, def, rows, false, credentials, options.fresh ?? true, kvReads)),
      }))
    );
    return { revision: snapshot.revision, settings, history: snapshot.history };
  } catch {
    throw new AdminSettingsUnavailableError();
  }
}
export type AdminSettingsView = Awaited<ReturnType<typeof readAdminSettings>>;

export { adminSettingCacheMs } from './admin-settings-cache';
