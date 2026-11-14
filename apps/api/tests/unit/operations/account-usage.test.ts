/**
 * sam_profiles_list accounts and sam_usage_get against a real SQL engine: the binding resolver,
 * the credential-limit reads and project authorization all run their production queries. Only the
 * SAM AI budget meter (KV) is mocked. Another member's credentials, pins and usage rows are seeded
 * beside the owner's and must never appear (rules 11, 28).
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { samProfilesList, samUsageGet } from '@simple-agent-manager/operations';
import {
  poolWindows,
  summarizePoolUsage,
} from '@simple-agent-manager/operations/internal/account-usage';
import type { CredentialLimitWindowSummary } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ tokens: vi.fn() }));
vi.mock('../../../src/services/ai-token-budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/ai-token-budget')>()),
  getTokenUsage: mocks.tokens,
  getUserBudgetSettings: vi.fn(async () => null),
}));

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const MIN = 60_000;
const SECRET = 'CIPHERTEXT-NEVER-RETURNED';

describe('connector account monitoring', () => {
  let sqlite: Database.Database;
  let env: Env;

  function ctx(userId = 'owner'): OperationContext {
    return {
      env,
      ports: createOperationPorts(env),
      requestId: 'test',
      actor: { userId, via: 'connector', scopes: new Set(['sam.read']) },
    };
  }

  function window(
    projectId: string,
    reference: string,
    windowType: string,
    fields: {
      userId?: string;
      source?: 'user' | 'project' | 'platform';
      agentType?: string;
      used: number | null;
      status?: string;
      level?: string;
      minutes?: number | null;
      resetsAt?: number | null;
      observedAt: number;
    }
  ) {
    sqlite
      .prepare(
        `INSERT INTO credential_limit_windows (project_id, credential_reference, window_type,
          credential_source, provider, provider_mode, agent_type, user_id, source, status,
          last_event_level, utilization_percent, window_minutes, resets_at, observed_at,
          created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        projectId,
        reference,
        windowType,
        fields.source ?? 'user',
        'anthropic',
        'direct',
        fields.agentType ?? 'claude-code',
        fields.userId ?? 'owner',
        'claude-acp.rate_limit',
        fields.status ?? 'allowed',
        fields.level ?? 'ok',
        fields.used,
        fields.minutes ?? null,
        fields.resetsAt ?? null,
        fields.observedAt,
        fields.observedAt,
        fields.observedAt
      );
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mocks.tokens.mockResolvedValue({ inputTokens: 1200, outputTokens: 300 });
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO users (id,name,email) VALUES ('owner','Owner','o@x'),('mate','Mate','m@x'),('outsider','Out','x@x');
      INSERT INTO projects (id,name,user_id) VALUES ('project','Project','owner'),('elsewhere','Elsewhere','owner');
      INSERT INTO project_members (project_id,user_id,role,status) VALUES
        ('project','owner','owner','active'),('project','mate','maintainer','active'),('elsewhere','owner','owner','active');
      INSERT INTO agent_profiles (id,project_id,user_id,name,agent_type,model) VALUES
        ('prof-a','project','owner','Claude A','claude-code','claude-opus-5-5'),
        ('prof-b','project','owner','Claude B','claude-code','claude-sonnet-5-5'),
        ('prof-codex','project','owner','Codex','openai-codex','gpt-6.1-sol'),
        ('prof-oc','project','owner','OpenCode','opencode',NULL),
        ('prof-none','project','owner','Vibe','mistral-vibe',NULL);
      INSERT INTO cc_credentials (id,owner_id,name,kind,encrypted_token,iv,is_active) VALUES
        ('max','owner','Work Max','oauth-token','${SECRET}','iv-1',1),
        ('max-mirror','owner','Work Max copy','oauth-token','${SECRET}','iv-1',1),
        ('codex','owner','Codex Pro','auth-json','codex-cipher','iv-2',1),
        ('mate-cred','mate','Mate Max','oauth-token','mate-cipher','iv-3',1);
      INSERT INTO cc_configurations (id,owner_id,name,consumer_kind,consumer_target,credential_id,is_active) VALUES
        ('cfg-max','owner','cfg','agent','claude-code','max',1),
        ('cfg-mirror','owner','cfg','agent','claude-code','max-mirror',1),
        ('cfg-codex','owner','cfg','agent','openai-codex','codex',1),
        ('cfg-mate','mate','cfg','agent','claude-code','mate-cred',1);
      INSERT INTO cc_attachments (id,configuration_id,consumer_kind,consumer_target,user_id,project_id,is_active) VALUES
        ('a-max','cfg-max','agent','claude-code','owner',NULL,1),
        ('a-codex','cfg-codex','agent','openai-codex','owner',NULL,1),
        ('a-mate','cfg-mate','agent','claude-code','mate',NULL,1);
      INSERT INTO cc_profile_attachments (id,configuration_id,user_id,agent_profile_id,consumer_kind,consumer_target,is_active) VALUES
        ('pin-b','cfg-mirror','owner','prof-b','agent','claude-code',1);
      INSERT INTO platform_credentials (id,credential_type,agent_type,label,encrypted_token,iv,is_enabled,created_by) VALUES
        ('plat-oc','agent-api-key','opencode','Platform','PLATFORM-SECRET','iv-p',1,'owner');
    `);
    // Max: a fresh 5h sample recorded in ANOTHER project (only the user-level read sees it) and a
    // stale, refused weekly sample on the mirror copy in this project.
    window('elsewhere', 'cc_credentials:max', 'claude.five_hour', {
      used: 40,
      minutes: 300,
      resetsAt: NOW + 120 * MIN,
      observedAt: NOW - 10 * MIN,
    });
    window('project', 'cc_credentials:max-mirror', 'claude.seven_day', {
      used: 100,
      status: 'rejected',
      level: 'rejected',
      minutes: 10_080,
      resetsAt: NOW + 3 * 24 * 60 * MIN,
      observedAt: NOW - 180 * MIN,
    });
    // An older 5h sample on the mirror must lose to the newer one on the original.
    window('project', 'cc_credentials:max-mirror', 'claude.five_hour', {
      used: 90,
      minutes: 300,
      resetsAt: NOW + 60 * MIN,
      observedAt: NOW - 50 * MIN,
    });
    window('project', 'cc_credentials:plat-oc', 'opencode.weekly', {
      source: 'platform',
      agentType: 'opencode',
      userId: 'mate',
      used: 12,
      observedAt: NOW - 5 * MIN,
    });
    // My own Claude account that no profile resolves to here: its usage belongs to no pool.
    window('project', 'cc_credentials:personal', 'claude.five_hour', {
      used: 77,
      observedAt: NOW - MIN,
    });
    // Mate's own account in the same project: never matched to the owner's pools.
    window('project', 'cc_credentials:mate-cred', 'claude.five_hour', {
      userId: 'mate',
      used: 99,
      observedAt: NOW - MIN,
    });
    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.com',
      KV: { get: vi.fn(async () => null) },
    } as unknown as Env;
  });
  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  it('sam_profiles_list names each profile’s account and shared pool without secrets', async () => {
    const result = await samProfilesList.run(ctx(), { projectId: 'project' });
    const byId = Object.fromEntries(result.profiles.map((profile) => [profile.id, profile]));
    expect(byId['prof-a']).toMatchObject({
      account: { state: 'account', tier: 'user', accountName: 'Work Max' },
    });
    expect(byId['prof-b']).toMatchObject({
      account: { state: 'account', tier: 'profile', accountName: 'Work Max copy' },
    });
    const accountA = 'account' in byId['prof-a']! ? byId['prof-a'].account : null;
    const accountB = 'account' in byId['prof-b']! ? byId['prof-b'].account : null;
    expect(accountA?.poolId).toMatch(/^pool_[0-9a-f]{16}$/);
    expect(accountA?.poolId).toBe(accountB?.poolId);
    // An enabled platform credential is never handed to a workspace, so it is no account.
    expect(byId['prof-oc']).toMatchObject({ account: { state: 'none', poolId: null } });
    expect(byId['prof-none']).toMatchObject({ account: { state: 'none', poolId: null } });
    expect(result).toMatchObject({ accountNote: expect.stringContaining('sam_usage_get') });
    const serialized = JSON.stringify(result);
    for (const secret of [
      SECRET,
      'iv-1',
      'PLATFORM-SECRET',
      'mate',
      'usageReferences',
      'cc_credentials',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('sam_usage_get reports one pool per shared credential with freshness and resets', async () => {
    const result = await samUsageGet.run(ctx(), { projectId: 'project' });
    const max = result.pools.find((pool) => pool.profiles.some((p) => p.id === 'prof-a'));
    expect(max).toMatchObject({
      kind: 'account',
      agentTypes: ['claude-code'],
      sharedBy: 2,
      profiles: [
        { id: 'prof-a', tier: 'user' },
        { id: 'prof-b', tier: 'profile' },
      ],
      usage: {
        state: 'reported',
        exhausted: true,
        remainingPercent: 0,
        nextResetAt: new Date(NOW + 3 * 24 * 60 * MIN).toISOString(),
        freshness: 'stale',
      },
    });
    const windows = max && 'windows' in max.usage ? max.usage.windows : [];
    expect(windows).toEqual([
      expect.objectContaining({
        windowType: 'claude.five_hour',
        usedPercent: 40,
        remainingPercent: 60,
        ageMinutes: 10,
        freshness: 'fresh',
      }),
      expect.objectContaining({
        windowType: 'claude.seven_day',
        status: 'rejected',
        ageMinutes: 180,
        freshness: 'stale',
      }),
    ]);
    // An account SAM never sampled is unknown, not full.
    expect(result.pools.find((pool) => pool.agentTypes.includes('openai-codex'))).toMatchObject({
      usage: { state: 'never_reported', remainingPercent: null, exhausted: null },
    });
    expect(result.profilesWithoutAccount).toEqual([
      { profileId: 'prof-oc', name: 'OpenCode', state: 'none', reason: null },
      { profileId: 'prof-none', name: 'Vibe', state: 'none', reason: null },
    ]);
    expect(result.staleAfterMinutes).toBe(60);
    expect(result.pools.every((pool) => pool.kind === 'account')).toBe(true);
    // No SAM proxy pool, so the SAM AI meter is not read.
    expect(mocks.tokens).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result);
    for (const leaked of [SECRET, 'iv-1', 'PLATFORM-SECRET', 'mate-cred', 'Mate Max', 'max-mirror'])
      expect(serialized).not.toContain(leaked);
    // Mate's 99% sample must not be counted anywhere.
    expect(serialized).not.toContain('"usedPercent":99');
    expect(serialized).not.toContain('"usedPercent":77');
    // Platform-sourced samples (any member's runs) are never attributed to a pool.
    expect(serialized).not.toContain('"usedPercent":12');
  });

  it('profileId narrows to that profile’s whole pool', async () => {
    const result = await samUsageGet.run(ctx(), { projectId: 'project', profileId: 'prof-b' });
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.profiles.map((profile) => profile.id)).toEqual(['prof-a', 'prof-b']);
    await expect(
      samUsageGet.run(ctx(), { projectId: 'project', profileId: 'missing' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('the stale threshold comes from the admin setting', async () => {
    sqlite
      .prepare(
        "INSERT INTO platform_settings (key, value, updated_at) VALUES ('connector.usageStaleAfterMinutes', '240', 0)"
      )
      .run();
    const result = await samUsageGet.run(ctx(), { projectId: 'project', profileId: 'prof-a' });
    expect(result.staleAfterMinutes).toBe(240);
    expect(result.pools[0]?.usage).toMatchObject({ freshness: 'fresh' });
  });

  it('a mate sees their own account for the same shared profile (owner-path control)', async () => {
    const result = await samUsageGet.run(ctx('mate'), {
      projectId: 'project',
      profileId: 'prof-a',
    });
    expect(result.pools[0]).toMatchObject({
      poolId: expect.stringMatching(/^pool_/),
      accountName: 'Mate Max',
      usage: { windows: [expect.objectContaining({ usedPercent: 99 })] },
    });
    expect(JSON.stringify(result)).not.toContain('Work Max');
  });

  it('a member with no account who chose SAM as provider gets the SAM AI proxy pool', async () => {
    sqlite.exec(`
      INSERT INTO users (id,name,email) VALUES ('solo','Solo','s@x');
      INSERT INTO project_members (project_id,user_id,role,status) VALUES ('project','solo','maintainer','active');
      INSERT INTO agent_settings (id,user_id,agent_type,provider_mode,created_at,updated_at)
        VALUES ('s-solo','solo','claude-code','sam','now','now');
    `);
    const result = await samUsageGet.run(ctx('solo'), { projectId: 'project' });
    expect(result.pools).toEqual([
      expect.objectContaining({
        poolId: 'sam-ai-proxy',
        kind: 'sam_ai_proxy',
        agentTypes: ['claude-code'],
        sharedBy: 2,
        usage: {
          state: 'sam_ai_budget',
          samAiToday: expect.objectContaining({ inputTokens: 1200, outputTokens: 300 }),
        },
      }),
    ]);
    // Codex without a SAM provider choice would fail to start: no pool.
    expect(result.profilesWithoutAccount.map((profile) => profile.profileId)).toEqual([
      'prof-codex',
      'prof-oc',
      'prof-none',
    ]);
    expect(mocks.tokens).toHaveBeenCalledWith(expect.anything(), 'solo', expect.anything());
  });

  it('non-members are refused', async () => {
    await expect(samUsageGet.run(ctx('outsider'), { projectId: 'project' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('summarizePoolUsage', () => {
  const base: CredentialLimitWindowSummary = {
    windowType: 'claude.five_hour',
    provider: 'anthropic',
    source: 'test',
    status: 'allowed',
    level: 'ok',
    utilizationPercent: 20,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: 300,
    resetsAt: NOW + 30 * MIN,
    observedAt: NOW - MIN,
    updatedAt: NOW - MIN,
  };

  it('has no capacity claim when there are no samples', () => {
    expect(summarizePoolUsage([], NOW, 60 * MIN)).toMatchObject({
      state: 'never_reported',
      exhausted: null,
      remainingPercent: null,
    });
  });

  it('uses the soonest upcoming reset when nothing is refused', () => {
    const later = { ...base, windowType: 'claude.seven_day', resetsAt: NOW + 600 * MIN };
    expect(summarizePoolUsage([base, later], NOW, 60 * MIN)).toMatchObject({
      exhausted: false,
      remainingPercent: 80,
      nextResetAt: new Date(NOW + 30 * MIN).toISOString(),
      freshness: 'fresh',
    });
  });

  it('an unknown reset on a refused window makes the comeback time unknown', () => {
    const refused = { ...base, status: 'rejected' as const, resetsAt: null };
    expect(summarizePoolUsage([base, refused], NOW, 60 * MIN)).toMatchObject({
      exhausted: true,
      nextResetAt: null,
    });
  });

  it('a window that reset since its sample is not exhausted and says so', () => {
    const reset = {
      ...base,
      status: 'allowed' as const,
      resetElapsed: true,
      utilizationPercent: 0,
    };
    expect(summarizePoolUsage([reset], NOW, 60 * MIN)).toMatchObject({
      exhausted: false,
      freshness: 'reset_since_sample',
      windows: [expect.objectContaining({ freshness: 'reset_since_sample' })],
    });
  });

  it('keeps the newest sample per window across copies of one credential', () => {
    const older = { ...base, utilizationPercent: 90, observedAt: NOW - 30 * MIN };
    const newer = { ...base, utilizationPercent: 10, observedAt: NOW - 2 * MIN };
    const summary = (window: CredentialLimitWindowSummary) => ({
      credentialReference: 'x',
      credentialId: null,
      credentialName: null,
      credentialSource: 'user' as const,
      provider: 'anthropic',
      providerMode: 'direct',
      agentType: 'claude-code',
      level: 'ok' as const,
      observedAt: window.observedAt,
      windows: [window],
    });
    expect(poolWindows([summary(older), summary(newer)])).toEqual([newer]);
  });
});

describe('listOwnCredentialLimitsByReferences', () => {
  it('reads digest-keyed rows of mine only, across projects, and restores the reference', async () => {
    const { listOwnCredentialLimitsByReferences } =
      await import('../../../src/services/credential-limit-events/read');
    const { credentialLimitReferenceKey } =
      await import('../../../src/services/credential-limit-events/values');
    const sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
    // Backfilled ids are long, so their rows are keyed by digest.
    const reference = `cc_credentials:cred-owner-${'c'.repeat(160)}`;
    const key = await credentialLimitReferenceKey(reference);
    expect(key).not.toBe(reference);
    const insert = sqlite.prepare(
      `INSERT INTO credential_limit_windows (project_id, credential_reference, window_type,
        credential_source, provider, provider_mode, agent_type, user_id, source, status,
        last_event_level, utilization_percent, window_minutes, resets_at, observed_at, created_at, updated_at)
       VALUES (?,?,?, 'user','anthropic','direct','claude-code',?, 's','allowed','ok',?,300,NULL,?,?,?)`
    );
    insert.run('p1', key, 'claude.five_hour', 'owner', 30, NOW - 20 * MIN, 0, 0);
    insert.run('p2', key, 'claude.five_hour', 'owner', 55, NOW - 5 * MIN, 0, 0);
    // The same key under another member's id must never be read for me.
    insert.run('p1', key, 'claude.seven_day', 'mate', 99, NOW, 0, 0);
    const result = await listOwnCredentialLimitsByReferences(env, {
      userId: 'owner',
      references: [reference, reference],
    });
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0]).toMatchObject({ credentialReference: reference });
    // Newest sample per window wins across projects.
    expect(result.credentials[0]?.windows).toEqual([
      expect.objectContaining({ windowType: 'claude.five_hour', utilizationPercent: 55 }),
    ]);
    sqlite.close();
  });
});
