/** Shared Phase 1 resolver and atomic, value-free audit boundary. */
import type { Env } from '../env';
import { resolveD1BindingIdentity } from '../lib/d1-session';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { errors } from '../middleware/error';
import {
  ADMIN_SETTINGS_CACHE_MAX_MS,
  AdminSettingsCache,
  AdminSettingsUnavailableError,
} from './admin-settings-cache';
import {
  ADMIN_SETTINGS_REGISTRY,
  type AdminSettingDefinition,
  type AdminSettingName,
  type AdminSettingValue,
  findAdminSetting,
  publicAdminSettingDefinition,
} from './admin-settings-registry';
import { decrypt } from './encryption';
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
const LEGACY_KV_CACHE_MAX_MS = 30_000;
function isOperationalSetting(name: AdminSettingName): boolean {
  return name === 'operations.cronSweepsEnabled' || name === 'operations.doAlarmsEnabled';
}
function assertGeneration(db: D1Database, generation: number): void {
  if (generationOf(db) !== generation) throw new AdminSettingsUnavailableError();
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
export type CredentialRow = {
  provider: string;
  kind: string;
  ciphertext: string;
  iv: string;
  updatedAt: string;
  updatedBy: string | null;
};
let credentialCache = new WeakMap<
  D1Database,
  { startedAt: number; expiresAt: number; promise: Promise<CredentialRow[]> }
>();
export async function credentialRows(env: Env, fresh = false, attempt = 0): Promise<CredentialRow[]> {
  if (attempt >= 3) throw new AdminSettingsUnavailableError();
  const db = resolveD1BindingIdentity(env.DATABASE);
  const generation = generationOf(db);
  const ttlMs = adminSettingCacheMs(env, 'integration.github.clientSecret');
  const useCache = !fresh && ttlMs > 0;
  const existing = credentialCache.get(db);
  if (
    useCache &&
    existing &&
    Math.min(existing.expiresAt, existing.startedAt + ttlMs) > Date.now()
  ) {
    const rows = await existing.promise;
    assertGeneration(db, generation);
    if (Date.now() >= Math.min(existing.expiresAt, existing.startedAt + ttlMs))
      throw new AdminSettingsUnavailableError();
    return rows;
  }
  const entry = {
    startedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    promise: db
      .prepare(
        'SELECT provider,credential_kind AS kind,encrypted_token AS ciphertext,iv,updated_at AS updatedAt,COALESCE(updated_by,created_by) AS updatedBy FROM platform_credentials WHERE credential_type=? AND is_enabled=1 ORDER BY updated_at DESC,created_at DESC'
      )
      .bind(INTEGRATION_CREDENTIAL_TYPE)
      .all<CredentialRow>()
      .then((result) => {
        if (!result.success) throw new AdminSettingsUnavailableError();
        return result.results;
      }),
  };
  if (useCache) credentialCache.set(db, entry);
  try {
    const rows = await entry.promise;
    if (useCache && credentialCache.get(db) !== entry)
      return credentialRows(env, false, attempt + 1);
    if (generationOf(db) !== generation || (ttlMs > 0 && Date.now() >= entry.expiresAt))
      throw new AdminSettingsUnavailableError();
    return rows;
  } catch {
    if (credentialCache.get(db) === entry) credentialCache.delete(db);
    throw new AdminSettingsUnavailableError();
  }
}
let kvCache = new WeakMap<
  D1Database,
  Map<string, { startedAt: number; expiresAt: number; promise: Promise<string | null> }>
>();
async function legacyKv(
  env: Env,
  key: string,
  fresh: boolean,
  ttlMs = LEGACY_KV_CACHE_MAX_MS,
  attempt = 0
) {
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
  if (useCache && cached && Math.min(cached.expiresAt, cached.startedAt + ttlMs) > Date.now()) {
    const value = await cached.promise;
    if (
      generationOf(db) !== generation ||
      Date.now() >= Math.min(cached.expiresAt, cached.startedAt + ttlMs)
    )
      throw new AdminSettingsUnavailableError();
    return value;
  }
  const entry = { startedAt: Date.now(), expiresAt: Date.now() + ttlMs, promise: env.KV.get(key) };
  if (useCache) map.set(key, entry);
  try {
    const value = await entry.promise;
    if (useCache && map.get(key) !== entry) return legacyKv(env, key, false, ttlMs, attempt + 1);
    if (generationOf(db) !== generation || (ttlMs > 0 && Date.now() >= entry.expiresAt))
      throw new AdminSettingsUnavailableError();
    return value;
  } catch {
    if (map.get(key) === entry) map.delete(key);
    throw new AdminSettingsUnavailableError();
  }
}
let disabled = new WeakMap<D1Database, Set<string>>();
/** Compatibility test seam; outstanding reads retain a distinct generation and must fail. */
export function __resetAdminSettingsCacheForTest(): void {
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
  fresh = false
): Promise<boolean> {
  const key = operationalKvKey(env, def);
  if (!key) return false;
  const value = await legacyKv(env, key, fresh, adminSettingCacheMs(env, def.name));
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
      ? await decrypt(result.ciphertext, result.iv, getCredentialEncryptionKey(env))
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
  fresh: boolean
) {
  const row = rows.find((row) => row.key === def.name);
  if (!row) return null;
  const value = parseValue(def, row.value);
  if (!validStoredValue(def, value)) throw new AdminSettingsUnavailableError();
  if (value === true && (await hasEmergencyVeto(env, def, fresh)))
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
async function legacyKvDetails(env: Env, def: AdminSettingDefinition, fresh: boolean) {
  if (!def.legacyKv) return null;
  let key = operationalKvKey(env, def);
  if (def.legacyKv === 'trials') key = env.TRIALS_ENABLED_KV_KEY ?? 'trials:enabled';
  if (!key) return null;
  const value = await legacyKv(env, key, fresh, adminSettingCacheMs(env, def.name));
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
  fresh = false
) {
  const stored = def.credential
    ? await credentialDetails(env, def, secretValue, credentials)
    : await overrideDetails(env, def, rows, fresh);
  if (stored) return stored;
  const environment = environmentDetails(env, def, secretValue);
  if (environment) return environment;
  const kv = await legacyKvDetails(env, def, fresh);
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
export async function resolveAdminSettingDetailsMany(env: Env, names: AdminSettingName[]) {
  const definitions = names.map(requiredDefinition);
  const primary = resolveD1BindingIdentity(env.DATABASE);
  const maxAge = Math.min(...names.map((name) => adminSettingCacheMs(env, name)));
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = generationOf(primary);
    try {
      const [rows, credentials] = await Promise.all([
        cache.read(primary, false, maxAge),
        credentialRows(env),
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
        await cache.read(env.DATABASE, false, adminSettingCacheMs(env, name)),
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
    const revisionBefore = await primary
      .prepare('SELECT revision FROM admin_settings_revision WHERE singleton=1')
      .first<{ revision: number }>();
    const rows = await cache.read(env.DATABASE, options.fresh ?? true);
    const credentials = await credentialRows(env, options.fresh ?? true);
    const revision = await primary
      .prepare('SELECT revision FROM admin_settings_revision WHERE singleton=1')
      .first<{ revision: number }>();
    if (!revision) throw new AdminSettingsUnavailableError();
    const settings = await Promise.all(
      ADMIN_SETTINGS_REGISTRY.map(async (def) => ({
        ...publicAdminSettingDefinition(def),
        ...(await resolved(env, def, rows, false, credentials, options.fresh ?? true)),
      }))
    );
    const history = await primary
      .prepare(
        'SELECT name,action,actor_user_id AS actorUserId,created_at AS createdAt,revision FROM admin_settings_audit ORDER BY revision DESC,name LIMIT 100'
      )
      .all<{
        name: string;
        action: 'set' | 'reset';
        actorUserId: string;
        createdAt: string;
        revision: number;
      }>();
    if (!history.success) throw new AdminSettingsUnavailableError();
    const revisionAfter = await primary
      .prepare('SELECT revision FROM admin_settings_revision WHERE singleton=1')
      .first<{ revision: number }>();
    if (
      revisionBefore?.revision !== revision.revision ||
      revisionAfter?.revision !== revision.revision
    )
      throw new AdminSettingsUnavailableError();
    return { revision: revision.revision, settings, history: history.results };
  } catch {
    throw new AdminSettingsUnavailableError();
  }
}
export type AdminSettingsView = Awaited<ReturnType<typeof readAdminSettings>>;
