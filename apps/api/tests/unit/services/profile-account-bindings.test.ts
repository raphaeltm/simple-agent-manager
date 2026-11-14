/**
 * Profile → account bindings for the Connector, against a real SQLite engine (rule 28). Secrets
 * are really encrypted so the parity test can run the decrypting admission selector
 * (`getSelectedAgentCredentialReference`) over the same rows: the metadata-only read must name the
 * credential a run would actually be seeded with. Another member's rows sit in the same tables as
 * the attack fixture.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { getSelectedAgentCredentialReference } from '../../../src/services/agent-credential-selection';
import { encrypt } from '../../../src/services/encryption';
import {
  resolveProfileAccountBindings,
  SAM_AI_PROXY_POOL_ID,
} from '../../../src/services/profile-account-bindings';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('resolveProfileAccountBindings', () => {
  let sqlite: Database.Database;
  let env: Env;
  let maxCipher: { ciphertext: string; iv: string };

  async function cred(
    id: string,
    owner: string,
    name: string,
    kind: string,
    secret: { ciphertext: string; iv: string } | string,
    active = 1
  ) {
    const enc = typeof secret === 'string' ? await encrypt(secret, KEY) : secret;
    sqlite
      .prepare(
        'INSERT INTO cc_credentials (id,owner_id,name,kind,encrypted_token,iv,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(id, owner, name, kind, enc.ciphertext, enc.iv, active, 'now', 'now');
    return enc;
  }
  const config = (id: string, owner: string, agentType: string, credentialId: string, active = 1) =>
    sqlite
      .prepare(
        "INSERT INTO cc_configurations (id,owner_id,name,consumer_kind,consumer_target,credential_id,is_active,created_at,updated_at) VALUES (?,?,?,'agent',?,?,?,'now','now')"
      )
      .run(id, owner, id, agentType, credentialId, active);
  const attach = (
    id: string,
    userId: string,
    configurationId: string,
    agentType: string,
    projectId: string | null
  ) =>
    sqlite
      .prepare(
        "INSERT INTO cc_attachments (id,configuration_id,consumer_kind,consumer_target,user_id,project_id,is_active,created_at,updated_at) VALUES (?,?,'agent',?,?,?,1,'now','now')"
      )
      .run(id, configurationId, agentType, userId, projectId);
  const pin = (
    id: string,
    userId: string,
    profileId: string,
    configurationId: string,
    agentType: string
  ) =>
    sqlite
      .prepare(
        "INSERT INTO cc_profile_attachments (id,configuration_id,user_id,agent_profile_id,consumer_kind,consumer_target,is_active,created_at,updated_at) VALUES (?,?,?,?,'agent',?,1,'now','now')"
      )
      .run(id, configurationId, userId, profileId, agentType);
  async function legacy(
    id: string,
    userId: string,
    agentType: string,
    projectId: string | null,
    active = 1,
    secret: { ciphertext: string; iv: string } | string = 'legacy-secret'
  ) {
    const enc = typeof secret === 'string' ? await encrypt(secret, KEY) : secret;
    sqlite
      .prepare(
        "INSERT INTO credentials (id,user_id,project_id,provider,credential_type,agent_type,credential_kind,is_active,encrypted_token,iv,created_at,updated_at) VALUES (?,?,?,'anthropic','agent-api-key',?,'api-key',?,?,?,'now','now')"
      )
      .run(id, userId, projectId, agentType, active, enc.ciphertext, enc.iv);
  }

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.ccCredentials,
      schema.ccConfigurations,
      schema.ccAttachments,
      schema.ccProfileAttachments,
      schema.platformCredentials,
      schema.credentials,
      schema.agentSettings,
    ]);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;

    // owner: one Max account stored twice with identical ciphertext (a dual-write mirror).
    maxCipher = await cred('max', 'owner', 'Work Max', 'oauth-token', 'sk-ant-max');
    await cred('max-mirror', 'owner', 'Work Max (copy)', 'oauth-token', maxCipher);
    await cred('codex', 'owner', 'Codex Pro', 'auth-json', '{"tokens":{}}');
    // A cloud-provider credential wired to an agent: the agent cannot use that kind.
    await cred('cloud', 'owner', 'Hetzner', 'cloud-provider', 'hcloud-token');
    config('cfg-max', 'owner', 'claude-code', 'max');
    config('cfg-mirror', 'owner', 'claude-code', 'max-mirror');
    config('cfg-codex', 'owner', 'openai-codex', 'codex');
    config('cfg-codex-off', 'owner', 'openai-codex', 'codex', 0);
    config('cfg-gem', 'owner', 'google-gemini', 'cloud');
    attach('a-user', 'owner', 'cfg-max', 'claude-code', null);
    attach('a-project', 'owner', 'cfg-mirror', 'claude-code', 'project-1');
    attach('a-codex', 'owner', 'cfg-codex', 'openai-codex', null);
    attach('a-gem', 'owner', 'cfg-gem', 'google-gemini', null);
    pin('pin-b', 'owner', 'prof-b', 'cfg-max', 'claude-code');
    pin('pin-paused', 'owner', 'prof-paused', 'cfg-codex-off', 'openai-codex');
    // OpenCode only in the legacy table, although the owner has cc rows for other agents.
    await legacy('legacy-oc', 'owner', 'opencode', null);

    // mate: their own account and a pin on the SAME shared profile prof-a.
    await cred('mate-cred', 'mate', 'Mate Account', 'oauth-token', 'sk-mate');
    config('cfg-mate', 'mate', 'claude-code', 'mate-cred');
    pin('pin-mate', 'mate', 'prof-a', 'cfg-mate', 'claude-code');
    sqlite
      .prepare(
        "INSERT INTO agent_settings (id,user_id,agent_type,provider_mode,created_at,updated_at) VALUES ('s-mate','mate','claude-code','sam','now','now')"
      )
      .run();

    const platform = await encrypt('PLATFORM-SECRET', KEY);
    sqlite
      .prepare(
        "INSERT INTO platform_credentials (id,credential_type,agent_type,credential_kind,label,encrypted_token,iv,is_enabled,created_by,created_at,updated_at) VALUES ('plat-claude','agent-api-key','claude-code','api-key','p',?,?,1,'admin','now','now')"
      )
      .run(platform.ciphertext, platform.iv);
  });
  afterEach(() => sqlite.close());

  const profiles = [
    { id: 'prof-a', agentType: 'claude-code' },
    { id: 'prof-b', agentType: 'claude-code' },
    { id: 'prof-codex', agentType: 'openai-codex' },
    { id: 'prof-paused', agentType: 'openai-codex' },
    { id: 'prof-gem', agentType: 'google-gemini' },
    { id: 'prof-oc', agentType: 'opencode' },
  ];
  const bind = (userId = 'owner', list = profiles, projectId = 'project-1') =>
    resolveProfileAccountBindings(env, { projectId, userId, profiles: list });

  it('resolves each tier and groups copies of one secret into one opaque pool', async () => {
    const byId = Object.fromEntries((await bind()).map((binding) => [binding.profileId, binding]));
    expect(byId['prof-a']).toMatchObject({
      state: 'account',
      tier: 'project',
      account: { name: 'Work Max (copy)', storage: 'account' },
    });
    expect(byId['prof-b']).toMatchObject({
      state: 'account',
      tier: 'profile',
      account: { name: 'Work Max' },
    });
    expect(byId['prof-a']?.poolId).toMatch(/^pool_[0-9a-f]{16}$/);
    expect(byId['prof-a']?.poolId).toBe(byId['prof-b']?.poolId);
    expect(byId['prof-a']?.usageReferences).toEqual([
      'cc_credentials:max',
      'cc_credentials:max-mirror',
    ]);
    expect(byId['prof-codex']).toMatchObject({ state: 'account', tier: 'user' });
    expect(byId['prof-codex']?.poolId).not.toBe(byId['prof-a']?.poolId);
    // An unusable pin stops the chain (rule 28), never falls back to the default.
    expect(byId['prof-paused']).toMatchObject({
      state: 'paused',
      tier: 'profile',
      reason: 'configuration-inactive',
      poolId: null,
    });
    // A cloud-provider credential cannot seed an agent.
    expect(byId['prof-gem']).toMatchObject({ state: 'none', poolId: null });
    // cc rows exist but none serve OpenCode: agent-key falls through to the legacy table.
    expect(byId['prof-oc']).toMatchObject({
      state: 'account',
      tier: 'user',
      account: { name: null, storage: 'legacy' },
      usageReferences: ['credentials:legacy-oc'],
    });
  });

  it('names the credential the real admission selector picks, for every kind of user', async () => {
    // A user with no cc rows (legacy only, one inactive project row), and a user whose cc
    // resolution yields only the platform default while a legacy key exists.
    await legacy('old-claude', 'old', 'claude-code', null);
    await legacy('old-codex-proj', 'old', 'openai-codex', 'project-1', 0);
    await legacy('old-codex', 'old', 'openai-codex', null);
    await legacy('plat-legacy', 'plat', 'claude-code', null);
    const db = drizzle(env.DATABASE);
    const checked: string[] = [];
    for (const userId of ['owner', 'mate', 'owner2', 'old', 'plat']) {
      for (const binding of await bind(userId)) {
        const selected = await getSelectedAgentCredentialReference(
          db,
          userId,
          binding.agentType,
          KEY,
          'project-1',
          { profileId: binding.profileId, agentType: binding.agentType }
        );
        const label = `${userId}/${binding.profileId}`;
        if (binding.state === 'account') {
          expect(binding.usageReferences, label).toContain(selected);
        } else {
          expect(selected, label).toBeNull();
        }
        checked.push(`${label}:${binding.state}`);
      }
    }
    // The fixture really covers each branch, so a passing loop is not vacuous.
    expect(checked).toEqual(
      expect.arrayContaining([
        'owner/prof-a:account',
        'owner/prof-paused:paused',
        'owner/prof-gem:none',
        'owner/prof-oc:account',
        'mate/prof-a:account',
        'old/prof-a:account',
        'old/prof-codex:paused',
        'plat/prof-a:account',
        'owner2/prof-a:none',
      ])
    );
  });

  it('reports no proxy when the installation turns the AI proxy off', async () => {
    sqlite
      .prepare(
        "INSERT INTO agent_settings (id,user_id,agent_type,provider_mode,created_at,updated_at) VALUES ('s0','owner2','claude-code','sam','now','now')"
      )
      .run();
    const list = [{ id: 'p-claude', agentType: 'claude-code' }];
    expect((await bind('owner2', list))[0]?.state).toBe('sam_ai_proxy');
    env = { ...env, AI_PROXY_ENABLED: 'false' } as Env;
    expect((await bind('owner2', list))[0]?.state).toBe('none');
  });

  it('a platform credential never counts as an account; SAM proxy only when chosen', async () => {
    // owner2 has no credentials at all; a platform Claude credential exists.
    const list = [
      { id: 'p-claude', agentType: 'claude-code' },
      { id: 'p-codex', agentType: 'openai-codex' },
      { id: 'p-oc', agentType: 'opencode' },
    ];
    expect((await bind('owner2', list)).map((binding) => binding.state)).toEqual([
      'none',
      'none',
      'none',
    ]);
    sqlite
      .prepare(
        "INSERT INTO agent_settings (id,user_id,agent_type,provider_mode,created_at,updated_at) VALUES ('s1','owner2','claude-code','sam','now','now'),('s2','owner2','opencode','sam','now','now')"
      )
      .run();
    expect(await bind('owner2', list)).toMatchObject([
      { state: 'sam_ai_proxy', poolId: SAM_AI_PROXY_POOL_ID, usageReferences: [] },
      { state: 'none' },
      // OpenCode never runs on the SAM proxy.
      { state: 'none' },
    ]);
  });

  it('never returns secret material, even for backfilled ids that embed ciphertext', async () => {
    const backfilled = await encrypt('sk-backfilled', KEY);
    const id = `cred-owner-${backfilled.ciphertext}:${backfilled.iv}`;
    await cred(id, 'owner', 'Migrated', 'oauth-token', backfilled);
    config('cfg-bf', 'owner', 'claude-code', id);
    pin('pin-bf', 'owner', 'prof-bf', 'cfg-bf', 'claude-code');
    const bindings = await bind('owner', [
      ...profiles,
      { id: 'prof-bf', agentType: 'claude-code' },
    ]);
    const exposed = JSON.stringify(bindings.map(({ usageReferences: _internal, ...rest }) => rest));
    for (const secret of [
      backfilled.ciphertext,
      backfilled.iv,
      maxCipher.ciphertext,
      maxCipher.iv,
      'max-mirror',
      'plat-claude',
      'PLATFORM-SECRET',
    ])
      expect(exposed).not.toContain(secret);
    expect(bindings.at(-1)).toMatchObject({
      state: 'account',
      poolId: expect.stringMatching(/^pool_/),
    });
  });

  it('a legacy key mirrored into cc joins that pool', async () => {
    await legacy('legacy-max', 'owner', 'claude-code', null, 1, maxCipher);
    const [binding] = await bind('owner', [{ id: 'prof-b', agentType: 'claude-code' }]);
    expect(binding?.usageReferences).toEqual([
      'cc_credentials:max',
      'cc_credentials:max-mirror',
      'credentials:legacy-max',
    ]);
  });

  it("another member's rows never leak into or change my answer (attack + owner control)", async () => {
    const [mine] = await bind('owner', [{ id: 'prof-a', agentType: 'claude-code' }]);
    expect(JSON.stringify(mine)).not.toContain('mate');
    expect(mine).toMatchObject({ tier: 'project', account: { name: 'Work Max (copy)' } });
    // Owner-path control: the same shared profile resolves to mate's own pin for mate.
    const [theirs] = await bind('mate', [{ id: 'prof-a', agentType: 'claude-code' }]);
    expect(theirs).toMatchObject({
      state: 'account',
      tier: 'profile',
      usageReferences: ['cc_credentials:mate-cred'],
      account: { name: 'Mate Account' },
    });
    // Mate's SAM provider mode does not apply to me.
    const [mineCodex] = await bind('owner2', [{ id: 'prof-a', agentType: 'claude-code' }]);
    expect(mineCodex?.state).toBe('none');
  });

  it('a project pin applies only in its own project', async () => {
    const [binding] = await bind(
      'owner',
      [{ id: 'prof-a', agentType: 'claude-code' }],
      'project-2'
    );
    expect(binding).toMatchObject({ tier: 'user', account: { name: 'Work Max' } });
  });

  it('falls back to the legacy table when the person has no cc rows, mirroring agent-key', async () => {
    await legacy('legacy-user', 'old', 'claude-code', null);
    await legacy('legacy-proj', 'old', 'openai-codex', 'project-1', 0);
    await legacy('legacy-other', 'old', 'openai-codex', null);
    const bindings = await bind('old', [
      { id: 'p1', agentType: 'claude-code' },
      { id: 'p2', agentType: 'openai-codex' },
    ]);
    expect(bindings[0]).toMatchObject({
      state: 'account',
      tier: 'user',
      usageReferences: ['credentials:legacy-user'],
      account: { name: null, storage: 'legacy' },
    });
    // An inactive project row halts rather than falling to the active user row (rule 28).
    expect(bindings[1]).toMatchObject({ state: 'paused', tier: 'project' });
  });

  it('reads nothing when there are no profiles', async () => {
    expect(await bind('owner', [])).toEqual([]);
  });
});
