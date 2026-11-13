/**
 * Profile → account bindings for the Connector, against a real SQLite engine (rule 28): every
 * scoping predicate is evaluated, another member's rows sit in the same tables as the attack
 * fixture, and the expected answers mirror the agent-key resolver's tiers.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { resolveProfileAccountBindings } from '../../../src/services/profile-account-bindings';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const SECRET_CIPHERTEXT = 'CIPHERTEXT-SHOULD-NEVER-LEAVE';

describe('resolveProfileAccountBindings', () => {
  let sqlite: Database.Database;
  let env: Env;

  const cred = (id: string, owner: string, name: string, token: string, iv: string, active = 1) =>
    sqlite
      .prepare(
        'INSERT INTO cc_credentials (id,owner_id,name,kind,encrypted_token,iv,is_active) VALUES (?,?,?,?,?,?,?)'
      )
      .run(id, owner, name, 'oauth-token', token, iv, active);
  const config = (id: string, owner: string, agentType: string, credentialId: string, active = 1) =>
    sqlite
      .prepare(
        "INSERT INTO cc_configurations (id,owner_id,name,consumer_kind,consumer_target,credential_id,is_active) VALUES (?,?,?,'agent',?,?,?)"
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
        "INSERT INTO cc_attachments (id,configuration_id,consumer_kind,consumer_target,user_id,project_id,is_active) VALUES (?,?,'agent',?,?,?,1)"
      )
      .run(id, configurationId, agentType, userId, projectId);
  const pin = (
    id: string,
    userId: string,
    profileId: string,
    configurationId: string,
    agentType: string,
    active = 1
  ) =>
    sqlite
      .prepare(
        "INSERT INTO cc_profile_attachments (id,configuration_id,user_id,agent_profile_id,consumer_kind,consumer_target,is_active) VALUES (?,?,?,?,'agent',?,?)"
      )
      .run(id, configurationId, userId, profileId, agentType, active);

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.ccCredentials,
      schema.ccConfigurations,
      schema.ccAttachments,
      schema.ccProfileAttachments,
      schema.platformCredentials,
      schema.credentials,
    ]);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;

    // owner: one Max account stored twice with identical ciphertext (a dual-write mirror),
    // one Codex account.
    cred('max', 'owner', 'Work Max', SECRET_CIPHERTEXT, 'iv-1');
    cred('max-mirror', 'owner', 'Work Max (copy)', SECRET_CIPHERTEXT, 'iv-1');
    cred('codex', 'owner', 'Codex Pro', 'other-ciphertext', 'iv-2');
    config('cfg-max', 'owner', 'claude-code', 'max');
    config('cfg-mirror', 'owner', 'claude-code', 'max-mirror');
    config('cfg-codex', 'owner', 'openai-codex', 'codex');
    attach('a-user', 'owner', 'cfg-max', 'claude-code', null);
    attach('a-project', 'owner', 'cfg-mirror', 'claude-code', 'project-1');
    attach('a-codex', 'owner', 'cfg-codex', 'openai-codex', null);
    pin('pin-b', 'owner', 'prof-b', 'cfg-max', 'claude-code');
    pin('pin-paused', 'owner', 'prof-paused', 'cfg-codex', 'openai-codex', 0);

    // mate: their own account, attachments and a pin on the SAME shared profile prof-a.
    cred('mate-cred', 'mate', 'Mate Account', 'mate-ciphertext', 'iv-3');
    config('cfg-mate', 'mate', 'claude-code', 'mate-cred');
    attach('a-mate', 'mate', 'cfg-mate', 'claude-code', 'project-1');
    pin('pin-mate', 'mate', 'prof-a', 'cfg-mate', 'claude-code');

    sqlite
      .prepare(
        "INSERT INTO platform_credentials (id,credential_type,agent_type,label,encrypted_token,iv,is_enabled,created_by) VALUES ('plat-oc','agent-api-key','opencode','p','PLATFORM-SECRET','iv-p',1,'admin')"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO platform_credentials (id,credential_type,agent_type,label,encrypted_token,iv,is_enabled,created_by) VALUES ('plat-off','agent-api-key','mistral-vibe','p','x','y',0,'admin')"
      )
      .run();
  });
  afterEach(() => sqlite.close());

  const profiles = [
    { id: 'prof-a', agentType: 'claude-code' },
    { id: 'prof-b', agentType: 'claude-code' },
    { id: 'prof-codex', agentType: 'openai-codex' },
    { id: 'prof-paused', agentType: 'openai-codex' },
    { id: 'prof-oc', agentType: 'opencode' },
    { id: 'prof-vibe', agentType: 'mistral-vibe' },
  ];

  it('resolves each tier and groups copies of one secret into one pool', async () => {
    const bindings = await resolveProfileAccountBindings(env, {
      projectId: 'project-1',
      userId: 'owner',
      profiles,
    });
    const byId = Object.fromEntries(bindings.map((binding) => [binding.profileId, binding]));
    // No pin of mine: my project pin wins (mate's pin on the same profile is ignored).
    expect(byId['prof-a']).toMatchObject({
      state: 'account',
      tier: 'project',
      account: { name: 'Work Max (copy)', storage: 'account' },
    });
    // My profile pin.
    expect(byId['prof-b']).toMatchObject({
      state: 'account',
      tier: 'profile',
      account: { name: 'Work Max' },
    });
    // Different stored rows, same ciphertext: one quota pool, both references kept for usage.
    expect(byId['prof-a']?.poolId).toBe(byId['prof-b']?.poolId);
    expect(byId['prof-a']?.usageReferences).toEqual([
      'cc_credentials:max',
      'cc_credentials:max-mirror',
    ]);
    expect(byId['prof-codex']).toMatchObject({
      state: 'account',
      tier: 'user',
      poolId: 'cc_credentials:codex',
    });
    expect(byId['prof-codex']?.poolId).not.toBe(byId['prof-a']?.poolId);
    // An inactive pin stops the chain (rule 28), never falls back to my default.
    expect(byId['prof-paused']).toMatchObject({
      state: 'paused',
      tier: 'profile',
      poolId: null,
      usageReferences: [],
    });
    expect(byId['prof-oc']).toMatchObject({
      state: 'platform',
      tier: 'platform',
      poolId: 'platform:opencode',
      account: null,
    });
    // A disabled platform row is no fallback.
    expect(byId['prof-vibe']).toMatchObject({ state: 'none', poolId: null });
  });

  it('never returns secret material', async () => {
    const bindings = await resolveProfileAccountBindings(env, {
      projectId: 'project-1',
      userId: 'owner',
      profiles,
    });
    const serialized = JSON.stringify(bindings);
    expect(serialized).not.toContain(SECRET_CIPHERTEXT);
    expect(serialized).not.toContain('iv-1');
    expect(serialized).not.toContain('PLATFORM-SECRET');
    expect(serialized).not.toContain('plat-oc');
  });

  it("another member's rows never leak into or change my answer (attack + owner control)", async () => {
    const mine = await resolveProfileAccountBindings(env, {
      projectId: 'project-1',
      userId: 'owner',
      profiles: [{ id: 'prof-a', agentType: 'claude-code' }],
    });
    expect(JSON.stringify(mine)).not.toContain('mate');
    // Owner-path control: the same shared profile resolves to mate's own pin for mate.
    const theirs = await resolveProfileAccountBindings(env, {
      projectId: 'project-1',
      userId: 'mate',
      profiles: [{ id: 'prof-a', agentType: 'claude-code' }],
    });
    expect(theirs[0]).toMatchObject({
      state: 'account',
      tier: 'profile',
      poolId: 'cc_credentials:mate-cred',
      account: { name: 'Mate Account' },
    });
  });

  it('a project pin applies only in its own project', async () => {
    const [binding] = await resolveProfileAccountBindings(env, {
      projectId: 'project-2',
      userId: 'owner',
      profiles: [{ id: 'prof-a', agentType: 'claude-code' }],
    });
    expect(binding).toMatchObject({ tier: 'user', account: { name: 'Work Max' } });
  });

  it('falls back to the legacy table when the person has no cc rows, mirroring agent-key', async () => {
    const legacy = sqlite.prepare(
      "INSERT INTO credentials (id,user_id,project_id,provider,credential_type,agent_type,is_active,encrypted_token,iv) VALUES (?,?,?,'anthropic','agent-api-key',?,?,?,?)"
    );
    legacy.run('legacy-user', 'old', null, 'claude-code', 1, 'L1', 'LIV1');
    legacy.run('legacy-proj', 'old', 'project-1', 'openai-codex', 0, 'L2', 'LIV2');
    legacy.run('legacy-other', 'old', null, 'openai-codex', 1, 'L3', 'LIV3');
    const bindings = await resolveProfileAccountBindings(env, {
      projectId: 'project-1',
      userId: 'old',
      profiles: [
        { id: 'p1', agentType: 'claude-code' },
        { id: 'p2', agentType: 'openai-codex' },
      ],
    });
    expect(bindings[0]).toMatchObject({
      state: 'account',
      tier: 'user',
      poolId: 'credentials:legacy-user',
      account: { name: null, storage: 'legacy' },
    });
    // Inactive project row halts rather than falling to the active user row (rule 28).
    expect(bindings[1]).toMatchObject({ state: 'paused', tier: 'project' });
    expect(JSON.stringify(bindings)).not.toContain('L1');
  });

  it('skips a malformed row instead of failing every profile (rule 50)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sqlite
      .prepare(
        "INSERT INTO cc_configurations (id,owner_id,name,consumer_kind,consumer_target,credential_id,is_active) VALUES ('bad','owner','bad','agent',NULL,'max',1)"
      )
      .run();
    const [binding] = await resolveProfileAccountBindings(env, {
      projectId: 'project-1',
      userId: 'owner',
      profiles: [{ id: 'prof-b', agentType: 'claude-code' }],
    });
    expect(binding).toMatchObject({ state: 'account', tier: 'profile' });
    warn.mockRestore();
  });

  it('reads nothing when there are no profiles', async () => {
    const prepare = vi.spyOn(env.DATABASE, 'prepare');
    expect(
      await resolveProfileAccountBindings(env, { projectId: 'p', userId: 'owner', profiles: [] })
    ).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });
});
