import type { Env } from '../env';
import { resolveD1BindingIdentity } from '../lib/d1-session';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { AppError, errors } from '../middleware/error';
import { AdminSettingsUnavailableError } from './admin-settings-cache';
import {
  ADMIN_SETTINGS_REGISTRY,
  type AdminSettingName,
  type AdminSettingValue,
  findAdminSetting,
} from './admin-settings-registry';
import {
  cache,
  type CredentialRow,
  credentialRows,
  invalidateAdminSettings,
  type OverrideRows,
  readAdminSettings,
  requiredDefinition,
  resolved,
} from './admin-settings-resolution';
import { encrypt } from './encryption';
import { INTEGRATION_CREDENTIAL_TYPE } from './platform-config-store';
import type { PlatformIntegrationInput } from './platform-config-types';
import { validatePlatformIntegrationInput } from './platform-config-validation';

type AuditChange = { name: AdminSettingName; action: 'set' | 'reset' };
function auditStatements(
  env: Env,
  changes: AuditChange[],
  actor: string,
  now: string,
  mutation: string
) {
  return changes.map((change) =>
    env.DATABASE.prepare(
      'INSERT INTO admin_settings_audit(id,name,action,actor_user_id,created_at,revision) SELECT ?,?,?,?,?,revision FROM admin_settings_revision WHERE singleton=1 AND mutation_id=?'
    ).bind(crypto.randomUUID(), change.name, change.action, actor, now, mutation)
  );
}
export async function commitAdminSettingsStatements(
  env: Env,
  input: {
    statements: D1PreparedStatement[];
    changes: AuditChange[];
    actorUserId: string;
    expectedRevision?: number;
  }
): Promise<void> {
  if (!input.changes.length) {
    await env.DATABASE.batch(input.statements);
    return;
  }
  const mutation = crypto.randomUUID();
  try {
    const result = await env.DATABASE.batch([
      ...(input.expectedRevision === undefined
        ? []
        : [
            env.DATABASE.prepare(
              'INSERT INTO admin_settings_revision(singleton) SELECT 1 FROM admin_settings_revision WHERE singleton=1 AND revision<>?'
            ).bind(input.expectedRevision),
          ]),
      env.DATABASE.prepare(
        'UPDATE admin_settings_revision SET revision=revision+1,mutation_id=? WHERE singleton=1'
      ).bind(mutation),
      ...input.statements,
      ...auditStatements(env, input.changes, input.actorUserId, new Date().toISOString(), mutation),
    ]);
    if (
      result.some((item) => !item.success) ||
      result[input.expectedRevision === undefined ? 0 : 1]?.meta.changes !== 1
    )
      throw new AdminSettingsUnavailableError();
  } catch (error) {
    if (
      input.expectedRevision !== undefined &&
      String(error).includes('admin_settings_revision.singleton')
    )
      throw errors.conflict('Settings changed. Reload before saving.');
    throw new AdminSettingsUnavailableError();
  } finally {
    invalidateAdminSettings(env);
  }
}
async function effectiveIntegrationValue(
  env: Env,
  changes: SettingsChange[],
  name: AdminSettingName,
  rows: OverrideRows,
  credentials: CredentialRow[],
  validateProviders: boolean
) {
  const change = changes.find((item) => item.name === name);
  if (change && change.value !== null) {
    if (validateProviders) return String(change.value).trim();
    return Boolean(change.value);
  }
  const reset = change?.value === null;
  const details = await resolved(
    env,
    requiredDefinition(name),
    reset ? [] : rows,
    validateProviders,
    reset ? [] : credentials,
    true
  );
  return validateProviders ? details.value : details.configured;
}
async function validateIntegrationSettingsChanges(
  primaryEnv: Env,
  changes: SettingsChange[],
  validateProviders: boolean
) {
  const touched = new Set(
    changes
      .filter((change) => change.name.startsWith('integration.'))
      .map((change) => change.name.split('.')[1])
  );
  if (!touched.size) return;
  const rows = await cache.read(primaryEnv.DATABASE, true),
    credentials = await credentialRows(primaryEnv, true);
  const integrationInput: PlatformIntegrationInput = {};
  for (const provider of ['github', 'google', 'googleInfrastructure', 'gitlab'] as const) {
    if (!touched.has(provider)) continue;

    const id = await effectiveIntegrationValue(
        primaryEnv,
        changes,
        `integration.${provider}.clientId`,
        rows,
        credentials,
        validateProviders
      ),
      secret = await effectiveIntegrationValue(
        primaryEnv,
        changes,
        `integration.${provider}.clientSecret`,
        rows,
        credentials,
        validateProviders
      );
    if (Boolean(id) !== Boolean(secret))
      throw errors.badRequest('OAuth client ID and secret must be configured or reset together.');
    if (validateProviders) {
      integrationInput[provider] = {
        clientId: String(id ?? ''),
        clientSecret: String(secret ?? ''),
      };
    }
  }
  if (validateProviders) {
    const validation = await validatePlatformIntegrationInput(primaryEnv, integrationInput);
    if (!validation.ok)
      throw errors.badRequest('Platform configuration is invalid', { errors: validation.errors });
  }
}
export async function validateAdminSettingsChanges(
  env: Env,
  changes: { name: AdminSettingName; value: AdminSettingValue }[],
  validateProviders = false
): Promise<number> {
  const primaryEnv = { ...env, DATABASE: resolveD1BindingIdentity(env.DATABASE) };
  const before = await primaryEnv.DATABASE.prepare(
    'SELECT revision FROM admin_settings_revision WHERE singleton=1'
  ).first<{ revision: number }>();
  if (!before) throw new AdminSettingsUnavailableError();
  await validateIntegrationSettingsChanges(primaryEnv, changes, validateProviders);
  const after = await primaryEnv.DATABASE.prepare(
    'SELECT revision FROM admin_settings_revision WHERE singleton=1'
  ).first<{ revision: number }>();
  if (before.revision !== after?.revision)
    throw errors.conflict('Settings changed. Reload before saving.');
  return before.revision;
}
type SettingsChange = { name: AdminSettingName; value: AdminSettingValue };
function validateMutationInput(input: {
  changes: SettingsChange[];
  expectedRevision?: number;
}): void {
  if (
    !input.changes.length ||
    input.changes.length > ADMIN_SETTINGS_REGISTRY.length ||
    new Set(input.changes.map((x) => x.name)).size !== input.changes.length ||
    input.changes.some(
      (change) =>
        !findAdminSetting(change.name) ||
        (change.value !== null && !requiredDefinition(change.name).validate(change.value))
    ) ||
    (input.expectedRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0))
  )
    throw errors.badRequest('Invalid admin settings change');
}
async function buildMutationStatements(
  env: Env,
  changes: SettingsChange[],
  actorUserId: string,
  mutation: string,
  now: string
): Promise<D1PreparedStatement[]> {
  const guard = 'EXISTS(SELECT 1 FROM admin_settings_revision WHERE singleton=1 AND mutation_id=?)';
  const statements: D1PreparedStatement[] = [];
  for (const change of changes) {
    const def = requiredDefinition(change.name);
    if (def.credential) {
      statements.push(
        env.DATABASE.prepare(
          `DELETE FROM platform_credentials WHERE credential_type=? AND provider=? AND credential_kind=? AND ${guard}`
        ).bind(INTEGRATION_CREDENTIAL_TYPE, def.credential.provider, def.credential.kind, mutation)
      );
      if (change.value !== null) {
        const encrypted = await encrypt(
          String(change.value).trim(),
          getCredentialEncryptionKey(env)
        );
        statements.push(
          env.DATABASE.prepare(
            `INSERT INTO platform_credentials(id,credential_type,provider,agent_type,credential_kind,label,encrypted_token,iv,is_enabled,created_by,created_at,updated_by,updated_at) SELECT ?,?,?,NULL,?,?,?,?,1,?,?,?,? WHERE ${guard}`
          ).bind(
            crypto.randomUUID(),
            INTEGRATION_CREDENTIAL_TYPE,
            def.credential.provider,
            def.credential.kind,
            def.description,
            encrypted.ciphertext,
            encrypted.iv,
            actorUserId,
            now,
            actorUserId,
            now,
            mutation
          )
        );
      }
    } else if (change.value === null)
      statements.push(
        env.DATABASE.prepare(`DELETE FROM platform_settings WHERE key=? AND ${guard}`).bind(
          change.name,
          mutation
        )
      );
    else
      statements.push(
        env.DATABASE.prepare(
          `INSERT INTO platform_settings(key,value,updated_at,updated_by) SELECT ?,?,?,? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`
        ).bind(
          change.name,
          def.type === 'string' ? String(change.value).trim() : JSON.stringify(change.value),
          now,
          actorUserId,
          mutation
        )
      );
  }
  return statements;
}
export async function updateAdminSettings(
  env: Env,
  input: {
    changes: { name: AdminSettingName; value: AdminSettingValue }[];
    actorUserId: string;
    expectedRevision?: number;
    validateProviders?: boolean;
  }
) {
  validateMutationInput(input);
  const validatedRevision = await validateAdminSettingsChanges(
    env,
    input.changes,
    input.validateProviders
  );
  if (input.expectedRevision !== undefined && input.expectedRevision !== validatedRevision)
    throw errors.conflict('Settings changed. Reload before saving.');
  const expectedRevision = input.expectedRevision ?? validatedRevision;
  const mutation = crypto.randomUUID(),
    now = new Date().toISOString();
  const statements = await buildMutationStatements(
    env,
    input.changes,
    input.actorUserId,
    mutation,
    now
  );
  let result: D1Result[];
  try {
    result = await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE admin_settings_revision SET revision=revision+1,mutation_id=? WHERE singleton=1 AND revision=?`
      ).bind(mutation, expectedRevision),
      ...statements,
      ...auditStatements(
        env,
        input.changes.map((x) => ({ name: x.name, action: x.value === null ? 'reset' : 'set' })),
        input.actorUserId,
        now,
        mutation
      ),
    ]);
    if (result.some((item) => !item.success)) throw new AdminSettingsUnavailableError();
  } catch {
    // A failed transport may have committed; discard cached state conservatively.
    invalidateAdminSettings(env);
    throw new AdminSettingsUnavailableError();
  }
  // A successful zero-change CAS fences every mutation/audit statement. It cannot
  // invalidate a winning writer's concurrent fresh response read.
  const changes = result[0]?.meta?.changes;
  if (changes === 0) throw errors.conflict('Settings changed. Reload before saving.');
  invalidateAdminSettings(env);
  if (changes !== 1) throw new AdminSettingsUnavailableError();
  await propagateOperationalEnables(env, input.changes);
  return readAdminSettings(env, { fresh: true });
}

async function propagateOperationalEnables(env: Env, changes: SettingsChange[]): Promise<void> {
  // A KV disable remains an independent emergency veto. Clear it only AFTER a
  // successful authoritative enable; a rejected CAS must never clear a brake.
  // D1 and KV are not atomic: a timeout may have applied, so report uncertainty.
  try {
    for (const change of changes) {
      if (
        change.value === true &&
        (change.name === 'operations.cronSweepsEnabled' ||
          change.name === 'operations.doAlarmsEnabled')
      ) {
        const key =
          change.name === 'operations.cronSweepsEnabled'
            ? (env.CRON_SWEEPS_ENABLED_KV_KEY ?? 'control-loops:cron-enabled')
            : (env.DO_ALARMS_ENABLED_KV_KEY ?? 'control-loops:alarms-enabled');
        await env.KV.put(key, 'true');
      }
    }
  } catch {
    throw new AppError(
      503,
      'SETTINGS_PROPAGATION_UNCERTAIN',
      'Settings were saved, but re-enable propagation is uncertain. Reload and verify each control before retrying.'
    );
  } finally {
    invalidateAdminSettings(env);
  }
}
