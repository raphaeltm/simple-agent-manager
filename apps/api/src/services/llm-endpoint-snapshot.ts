/** Joint endpoint URL/key snapshot: independent caches can mix remote admin generations. */
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import type { Env } from '../env';
import { resolveD1BindingIdentity } from '../lib/d1-session';
import { settleSharedFlight } from '../lib/shared-flight';
import { ADMIN_SETTINGS_CACHE_MAX_MS, AdminSettingsUnavailableError } from './admin-settings-cache';
import { type AdminSettingName } from './admin-settings-registry';
import { adminSettingsGeneration, requiredDefinition, resolved } from './admin-settings-resolution';
import { DEFAULT_CONFIG_READ_TIMEOUT_MS } from './config-read-deadline';
import { withDeadline } from './fetch-timeout';
import { INTEGRATION_CREDENTIAL_TYPE } from './platform-config-store';

const overrideSchema = v.object({
  key: v.string(),
  value: v.string(),
  updatedAt: v.string(),
  updatedBy: v.nullable(v.string()),
});
const credentialSchema = v.object({
  id: v.string(),
  provider: v.string(),
  kind: v.string(),
  ciphertext: v.string(),
  iv: v.string(),
  updatedAt: v.string(),
  updatedBy: v.nullable(v.string()),
});
type Snapshot = {
  rows: v.InferOutput<typeof overrideSchema>[];
  credentials: v.InferOutput<typeof credentialSchema>[];
};
type Entry = {
  generation: number;
  expiresAt: number;
  /** When the load's own deadline fires; joiners wait until then (plus grace), never longer. */
  deadlineAt: number;
  promise: Promise<Snapshot>;
};
const snapshots = new WeakMap<D1Database, Entry>();

async function load(env: Env, db: D1Database): Promise<Snapshot> {
  // D1 batch is transactional: both halves are from one primary snapshot, even when another
  // isolate rotates the endpoint while this read is in flight. Only encrypted keys are cached.
  const results = await db.batch([
    db.prepare(
      'SELECT key,value,updated_at AS updatedAt,updated_by AS updatedBy FROM platform_settings'
    ),
    db
      .prepare(
        'SELECT id,provider,credential_kind AS kind,encrypted_token AS ciphertext,iv,updated_at AS updatedAt,COALESCE(updated_by,created_by) AS updatedBy FROM platform_credentials WHERE credential_type=? AND provider=? AND credential_kind=? AND is_enabled=1 ORDER BY updated_at DESC,created_at DESC'
      )
      .bind(INTEGRATION_CREDENTIAL_TYPE, 'openai-compatible', 'api-key'),
  ]);
  if (results.length !== 2 || results.some((result) => !result.success))
    throw new AdminSettingsUnavailableError();
  const rows = v.safeParse(v.array(overrideSchema), results[0]?.results);
  if (!rows.success) throw new AdminSettingsUnavailableError();
  const credentials: Snapshot['credentials'] = [];
  for (const row of results[1]?.results ?? []) {
    const parsed = v.safeParse(credentialSchema, row);
    try {
      if (!parsed.success) throw new AdminSettingsUnavailableError();
      // Validate/decrypt each candidate independently; a malformed legacy row cannot hide a
      // later usable key. Never log parser/decryption messages carrying credential material.
      await resolved(env, requiredDefinition('llm.openAICompatible.apiKey'), rows.output, true, [
        parsed.output,
      ]);
      credentials.push(parsed.output);
    } catch {
      log.warn('llm_endpoint.credential_row_skipped', {
        credentialId: parsed.success ? parsed.output.id : undefined,
        provider: 'openai-compatible',
        kind: 'api-key',
        reason: 'invalid_credential',
      });
    }
  }
  // No key is a valid explicit setup; stored keys that cannot be read are an outage.
  if ((results[1]?.results.length ?? 0) > 0 && credentials.length === 0)
    throw new AdminSettingsUnavailableError();
  return { rows: rows.output, credentials };
}

/** One atomic batch per isolate TTL, shared across purposes and request-scoped D1 facades. */
export async function resolveLlmEndpointSettings(env: Env, names: AdminSettingName[]) {
  const db = resolveD1BindingIdentity(env.DATABASE);
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = adminSettingsGeneration(db);
    let entry = snapshots.get(db);
    if (!entry || entry.generation !== generation || Date.now() >= entry.expiresAt) {
      entry = {
        generation,
        expiresAt: Date.now() + ADMIN_SETTINGS_CACHE_MAX_MS,
        deadlineAt: Date.now() + DEFAULT_CONFIG_READ_TIMEOUT_MS,
        promise: withDeadline(() => load(env, db), DEFAULT_CONFIG_READ_TIMEOUT_MS),
      };
      snapshots.set(db, entry);
    }
    try {
      // Another request may have started this load; on a runtime that drops a disconnected
      // request's I/O it can never settle, so join it with a bound (packages/worker-core
      // shared-flight.ts) and start a fresh load if it was abandoned.
      const joined = await settleSharedFlight(entry.promise, entry.deadlineAt);
      if (joined.abandoned) {
        if (snapshots.get(db) === entry) snapshots.delete(db);
        continue;
      }
      const snapshot = joined.value;
      const values = await Promise.all(
        names.map((name) =>
          resolved(env, requiredDefinition(name), snapshot.rows, true, snapshot.credentials)
        )
      );
      if (generation !== adminSettingsGeneration(db)) continue;
      if (Date.now() >= entry.expiresAt) throw new AdminSettingsUnavailableError();
      return values;
    } catch (error) {
      if (snapshots.get(db) === entry) snapshots.delete(db);
      if (generation !== adminSettingsGeneration(db)) continue;
      throw error;
    }
  }
  throw new AdminSettingsUnavailableError();
}
