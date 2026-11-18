/** One D1 batch gives the admin view one atomic primary snapshot. */
import * as v from 'valibot';

import { AdminSettingsUnavailableError } from './admin-settings-cache';
import { INTEGRATION_CREDENTIAL_TYPE } from './platform-config-store';

const overrides = v.array(
  v.object({
    key: v.string(),
    value: v.string(),
    updatedAt: v.string(),
    updatedBy: v.nullable(v.string()),
  })
);
const credentials = v.array(
  v.object({
    provider: v.string(),
    kind: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    updatedAt: v.string(),
    updatedBy: v.nullable(v.string()),
  })
);
const history = v.array(
  v.object({
    name: v.string(),
    action: v.picklist(['set', 'reset']),
    actorUserId: v.string(),
    createdAt: v.string(),
    revision: v.number(),
  })
);

export async function readAdminSettingsSnapshot(primary: D1Database) {
  const results = await primary.batch([
    primary.prepare('SELECT revision FROM admin_settings_revision WHERE singleton=1'),
    primary.prepare(
      'SELECT key,value,updated_at AS updatedAt,updated_by AS updatedBy FROM platform_settings'
    ),
    primary
      .prepare(
        'SELECT provider,credential_kind AS kind,encrypted_token AS ciphertext,iv,updated_at AS updatedAt,COALESCE(updated_by,created_by) AS updatedBy FROM platform_credentials WHERE credential_type=? AND is_enabled=1 ORDER BY updated_at DESC,created_at DESC'
      )
      .bind(INTEGRATION_CREDENTIAL_TYPE),
    primary.prepare(
      'SELECT name,action,actor_user_id AS actorUserId,created_at AS createdAt,revision FROM admin_settings_audit ORDER BY revision DESC,name LIMIT 100'
    ),
  ]);
  if (results.length !== 4 || results.some((result) => !result.success))
    throw new AdminSettingsUnavailableError();
  const [revision, rows, credentialRows, audit] = results;
  if (!revision || !rows || !credentialRows || !audit) throw new AdminSettingsUnavailableError();
  return {
    revision: v.parse(v.array(v.object({ revision: v.number() })), revision.results)[0]?.revision,
    rows: v.parse(overrides, rows.results),
    credentials: v.parse(credentials, credentialRows.results),
    history: v.parse(history, audit.results),
  };
}
