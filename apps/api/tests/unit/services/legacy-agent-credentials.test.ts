/**
 * Legacy `credentials` precedence for agent runs, on a real SQL engine (rule 28): the agent-key
 * path (`getDecryptedAgentKey`, which decrypts the chosen row) and the selection-only path
 * (`getSelectedAgentCredentialReference`) share `pickLegacyAgentCredential`, so each case asserts
 * both. Lazy backfill is held off so the legacy table is what decides.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { getSelectedAgentCredentialReference } from '../../../src/services/agent-credential-selection';
import { getDecryptedAgentKey } from '../../../src/services/agent-key-resolution';
import { encrypt } from '../../../src/services/encryption';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/composable-credentials/lazy-backfill', () => ({
  lazyBackfillIfNeeded: vi.fn().mockResolvedValue(false),
  hasUserCCData: vi.fn().mockResolvedValue(false),
}));

const KEY = Buffer.alloc(32, 5).toString('base64');

describe('legacy agent credential precedence', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  async function row(
    id: string,
    fields: {
      userId?: string;
      projectId: string | null;
      active?: boolean;
      kind?: string;
      secret?: string;
    }
  ) {
    const enc = await encrypt(fields.secret ?? `secret-${id}`, KEY);
    sqlite
      .prepare(
        "INSERT INTO credentials (id,user_id,project_id,provider,credential_type,agent_type,credential_kind,is_active,encrypted_token,iv,created_at,updated_at) VALUES (?,?,?,'anthropic','agent-api-key','claude-code',?,?,?,?,'now','now')"
      )
      .run(
        id,
        fields.userId ?? 'u1',
        fields.projectId,
        fields.kind ?? 'api-key',
        fields.active === false ? 0 : 1,
        enc.ciphertext,
        enc.iv
      );
  }

  const both = async (projectId: string | null, userId = 'u1') => ({
    key: await getDecryptedAgentKey(db, userId, 'claude-code', KEY, projectId),
    selected: await getSelectedAgentCredentialReference(db, userId, 'claude-code', KEY, projectId),
  });

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.credentials,
      schema.ccCredentials,
      schema.ccConfigurations,
      schema.ccAttachments,
      schema.ccProfileAttachments,
      schema.platformCredentials,
    ]);
    db = drizzle(createSqliteD1(sqlite));
  });
  afterEach(() => sqlite.close());

  it('uses the project-scoped row when the project has one', async () => {
    await row('user-row', { projectId: null });
    await row('project-row', { projectId: 'p1', secret: 'sk-project' });
    const { key, selected } = await both('p1');
    expect(key).toMatchObject({ credential: 'sk-project', credentialSource: 'project' });
    expect(selected).toBe('credentials:project-row');
  });

  it('falls back to the user-scoped row when the project has none', async () => {
    await row('user-row', { projectId: null, kind: 'oauth-token', secret: 'sk-user' });
    await row('other-project', { projectId: 'p2' });
    const { key, selected } = await both('p1');
    expect(key).toMatchObject({
      credential: 'sk-user',
      credentialKind: 'oauth-token',
      credentialSource: 'user',
    });
    expect(selected).toBe('credentials:user-row');
  });

  it('ignores project rows when there is no project', async () => {
    await row('project-row', { projectId: 'p1' });
    await row('user-row', { projectId: null, secret: 'sk-user' });
    const { key, selected } = await both(null);
    expect(key?.credential).toBe('sk-user');
    expect(selected).toBe('credentials:user-row');
  });

  it('an inactive project row halts instead of falling back to the user row (rule 28)', async () => {
    await row('project-row', { projectId: 'p1', active: false });
    await row('user-row', { projectId: null });
    const { key, selected } = await both('p1');
    expect(key).toBeNull();
    expect(selected).toBeNull();
    // Owner-path control: the same user row is used in a project without an override.
    expect((await both('p2')).selected).toBe('credentials:user-row');
  });

  it('falls through to an enabled platform credential, which is never a selectable account', async () => {
    const platform = await encrypt('sk-platform', KEY);
    sqlite
      .prepare(
        "INSERT INTO platform_credentials (id,credential_type,agent_type,credential_kind,label,encrypted_token,iv,is_enabled,created_by,created_at,updated_at) VALUES ('plat','agent-api-key','claude-code','api-key','p',?,?,1,'admin','now','now')"
      )
      .run(platform.ciphertext, platform.iv);
    const { key, selected } = await both('p1');
    expect(key).toMatchObject({ credential: 'sk-platform', credentialSource: 'platform' });
    expect(selected).toBeNull();
  });

  it('skips an inactive user row and another member’s rows', async () => {
    await row('inactive-user', { projectId: null, active: false });
    await row('mate-row', { userId: 'mate', projectId: null });
    const { key, selected } = await both('p1');
    expect(key).toBeNull();
    expect(selected).toBeNull();
    // Control: mate's row is mate's.
    expect((await both('p1', 'mate')).selected).toBe('credentials:mate-row');
  });
});
