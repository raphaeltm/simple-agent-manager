import type { Env } from '../env';
import type { AdminSettingName } from './admin-settings-registry';
import {
  INTEGRATION_GROUP_STORAGE,
  type IntegrationAuditName,
  integrationSetAuditNames,
} from './platform-config-groups';
import { INTEGRATION_CREDENTIAL_TYPE, trimOptional } from './platform-config-store';
import type { PlatformIntegrationInput, ResolvedPlatformValue } from './platform-config-types';

/* What a platform integration save or clear changes, for validation, audit and owner alerts. */

/** One audited change to a platform integration field. Names only, never values. */
export interface PlatformIntegrationChange {
  name: IntegrationAuditName;
  action: 'set' | 'reset';
}

/**
 * Every field the save writes (`set`) plus every stored field a clear deletes (`reset`). Only
 * rows that actually exist are recorded as reset, so the audit and the owner alert never claim
 * a clear removed something that was not there.
 */
export async function integrationAuditChanges(
  env: Env,
  input: PlatformIntegrationInput
): Promise<PlatformIntegrationChange[]> {
  const changes: PlatformIntegrationChange[] = integrationSetAuditNames(input).map((name) => ({
    name,
    action: 'set',
  }));
  const groups = [...new Set(input.clear ?? [])];
  if (groups.length === 0) return changes;
  const [settingRows, credentialRows] = await Promise.all([
    env.DATABASE.prepare("SELECT key FROM platform_settings WHERE key LIKE 'integration.%'").all<{
      key: string;
    }>(),
    env.DATABASE.prepare(
      'SELECT DISTINCT provider, credential_kind AS kind FROM platform_credentials WHERE credential_type = ?'
    )
      .bind(INTEGRATION_CREDENTIAL_TYPE)
      .all<{ provider: string; kind: string }>(),
  ]);
  const storedKeys = new Set((settingRows.results ?? []).map((row) => row.key));
  const storedCredentials = new Set(
    (credentialRows.results ?? []).map((row) => `${row.provider}/${row.kind}`)
  );
  for (const group of groups) {
    const storage = INTEGRATION_GROUP_STORAGE[group];
    for (const setting of storage.settings) {
      if (storedKeys.has(setting.key)) changes.push({ name: setting.auditName, action: 'reset' });
    }
    for (const credential of storage.credentials) {
      if (storedCredentials.has(`${credential.provider}/${credential.kind}`)) {
        changes.push({ name: credential.auditName, action: 'reset' });
      }
    }
  }
  return changes;
}

/**
 * Registry OAuth values this input SETS, for `validateAdminSettingsChanges` (revision fence plus
 * the client id/secret pairing check). Clears are deliberately excluded: an admin must always be
 * able to delete stored values, even when the environment fallback that reappears is incomplete.
 */
export function integrationChanges(
  input: PlatformIntegrationInput
): Array<{ name: AdminSettingName; value: string | null }> {
  const changes: Array<{ name: AdminSettingName; value: string | null }> = [];
  for (const provider of ['github', 'google', 'googleInfrastructure', 'gitlab'] as const) {
    const config = input[provider] as Record<string, string | undefined> | undefined;
    if (!config) continue;
    for (const field of provider === 'gitlab'
      ? ['host', 'clientId', 'clientSecret']
      : ['clientId', 'clientSecret']) {
      const value = trimOptional(config[field]);
      if (value)
        changes.push({ name: `integration.${provider}.${field}` as AdminSettingName, value });
    }
  }
  return changes;
}

/**
 * Maps an admin-settings resolution source onto the source shown in Admin → Integrations.
 * Exhaustive on purpose: an unknown source must not silently become "environment fallback",
 * because that label tells an operator a value is outside SAM's database when it may not be.
 */
export function platformSourceFromSetting(
  source: 'database' | 'environment' | 'kv' | 'default'
): ResolvedPlatformValue['source'] {
  switch (source) {
    case 'database':
      return 'runtime';
    case 'environment':
      return 'environment';
    case 'kv':
      return 'legacy-kv';
    case 'default':
      return 'unset';
  }
}

/**
 * Keeps only the clear groups that had a stored row when the audit was read. Every delete the
 * commit runs is therefore matched by a `reset` audit row, which also puts the commit behind the
 * admin-settings revision CAS (`commitAdminSettingsStatements` fences only audited batches). A row
 * written after `validateAdminSettingsChanges` read the revision bumps it, so the CAS refuses the
 * clear instead of deleting that row silently; a group with nothing stored is a no-op.
 */
export function withStoredClearsOnly(
  input: PlatformIntegrationInput,
  changes: PlatformIntegrationChange[]
): PlatformIntegrationInput {
  if (!input.clear?.length) return input;
  const reset = new Set(changes.filter((c) => c.action === 'reset').map((c) => c.name));
  const clear = input.clear.filter((group) => {
    const storage = INTEGRATION_GROUP_STORAGE[group];
    return [...storage.settings, ...storage.credentials].some((item) => reset.has(item.auditName));
  });
  return { ...input, clear };
}
