import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { recordCredentialLimitObservation } from '../../../src/services/credential-limit-events';
import {
  listProjectCredentialLimits,
  listUserCredentialLimits,
  resolveAgentSessionCredentialReference,
} from '../../../src/services/credential-limit-events/read';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

type WindowSeed = {
  projectId?: string;
  credentialReference?: string;
  windowType?: string;
  credentialSource?: string;
  provider?: string;
  providerMode?: string;
  agentType?: string | null;
  userId?: string;
  source?: string;
  status?: string;
  lastEventLevel?: string;
  utilizationPercent?: number | null;
  windowMinutes?: number | null;
  resetsAt?: number | null;
  observedAt?: number;
  updatedAt?: number;
};

/**
 * Real SQLite engine: the scoping predicates (`user_id = ?`, `credential_source IN …`,
 * `project_id = ?`) are evaluated for real, not mocked away (.claude/rules/28 §5).
 */
function setup() {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.credentialLimitWindows,
    schema.agentSessions,
    schema.workspaces,
    schema.ccCredentials,
  ]);
  const env = { DATABASE: createSqliteD1(sqlite) } as Env;

  const seedWindow = (seed: WindowSeed) => {
    sqlite
      .prepare(
        `INSERT INTO credential_limit_windows (
           project_id, credential_reference, window_type, credential_source, provider,
           provider_mode, agent_type, user_id, source, status, last_event_level,
           utilization_percent, window_minutes, resets_at, observed_at, freshness_ms,
           duplicate_sample_count, stale_sample_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`
      )
      .run(
        seed.projectId ?? 'project-1',
        seed.credentialReference ?? 'cc_credentials:cred-owner',
        seed.windowType ?? 'claude.five_hour',
        seed.credentialSource ?? 'user',
        seed.provider ?? 'anthropic',
        seed.providerMode ?? 'direct',
        seed.agentType === undefined ? 'claude-code' : seed.agentType,
        seed.userId ?? 'owner-1',
        seed.source ?? 'claude-acp.rate_limit',
        seed.status ?? 'allowed',
        seed.lastEventLevel ?? 'ok',
        seed.utilizationPercent === undefined ? 42 : seed.utilizationPercent,
        seed.windowMinutes === undefined ? 300 : seed.windowMinutes,
        seed.resetsAt === undefined ? 1_700_000_900_000 : seed.resetsAt,
        seed.observedAt ?? 1_700_000_000_000,
        seed.observedAt ?? 1_700_000_000_000,
        seed.updatedAt ?? seed.observedAt ?? 1_700_000_000_000
      );
  };

  const seedSession = (input: {
    sessionId: string;
    workspaceId: string;
    projectId: string;
    credentialReference: string | null;
  }) => {
    sqlite
      .prepare(`INSERT INTO workspaces (id, project_id, user_id, status) VALUES (?, ?, ?, ?)`)
      .run(input.workspaceId, input.projectId, 'owner-1', 'running');
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, created_at, updated_at, agent_credential_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.workspaceId,
        'owner-1',
        'running',
        'openai-codex',
        '2026-10-05T00:00:00Z',
        '2026-10-05T00:00:00Z',
        input.credentialReference
      );
  };

  return { sqlite, env, seedWindow, seedSession };
}

describe('listProjectCredentialLimits', () => {
  it("orders each credential's windows shortest-span first, unknown spans last", async () => {
    const { env, seedWindow } = setup();
    const opencode = {
      credentialReference: 'cc_credentials:cred-opencode',
      provider: 'opencode',
      agentType: 'opencode',
      source: 'vm-agent.opencode_go_usage',
    };
    // Seeded in the alphabetical order the old sort produced (month, rolling, week).
    // All WITHOUT a reported length — exactly what the OpenCode Go endpoint yields on
    // staging — so ordering must come from the nominal span of the window type.
    seedWindow({ ...opencode, windowType: 'opencode.monthly', windowMinutes: null });
    seedWindow({ ...opencode, windowType: 'opencode.rolling', windowMinutes: null });
    seedWindow({ ...opencode, windowType: 'opencode.weekly', windowMinutes: null });

    const response = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'owner-1',
    });
    const credential = response.credentials.find(
      (c) => c.credentialReference === 'cc_credentials:cred-opencode'
    );
    expect(credential?.windows.map((window) => window.windowType)).toEqual([
      'opencode.rolling',
      'opencode.weekly',
      'opencode.monthly',
    ]);

    // A reported length wins over the nominal span, and unknown spans sort last.
    const codex = {
      credentialReference: 'cc_credentials:cred-codex',
      provider: 'openai',
      agentType: 'openai-codex',
      source: 'vm-agent.codex_rollout',
    };
    seedWindow({ ...codex, windowType: 'codex.secondary', windowMinutes: 300 });
    seedWindow({ ...codex, windowType: 'codex.primary', windowMinutes: null });
    const again = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'owner-1',
    });
    expect(
      again.credentials
        .find((c) => c.credentialReference === 'cc_credentials:cred-codex')
        ?.windows.map((window) => window.windowType)
    ).toEqual(['codex.secondary', 'codex.primary']);
  });

  it("returns the caller's own rows plus shared rows, never another member's personal credential", async () => {
    const { env, seedWindow } = setup();
    // Owner-path control: the caller's personal Claude credential.
    seedWindow({ windowType: 'claude.five_hour', utilizationPercent: 72, lastEventLevel: 'ok' });
    seedWindow({
      windowType: 'claude.seven_day',
      utilizationPercent: 91,
      lastEventLevel: 'critical',
    });
    // Project-shared Codex credential used by another member — visible.
    seedWindow({
      credentialReference: 'cc_credentials:cred-shared',
      credentialSource: 'project',
      provider: 'openai',
      agentType: 'openai-codex',
      userId: 'member-2',
      windowType: 'codex.primary',
      source: 'vm-agent.codex_rollout',
      windowMinutes: 300,
      utilizationPercent: 12,
    });
    // Platform credential — visible.
    seedWindow({
      credentialReference: 'platform_credentials:plat-1',
      credentialSource: 'platform',
      provider: 'anthropic',
      userId: 'member-3',
      windowType: 'anthropic.tokens',
      source: 'ai-proxy-anthropic.messages',
      utilizationPercent: 5,
    });
    // ATTACK FIXTURE: another member's PERSONAL credential in the same project.
    seedWindow({
      credentialReference: 'cc_credentials:cred-private-of-member-2',
      credentialSource: 'user',
      userId: 'member-2',
      windowType: 'claude.five_hour',
      utilizationPercent: 99,
      lastEventLevel: 'critical',
    });

    const response = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'owner-1',
    });
    const references = response.credentials
      .map((credential) => credential.credentialReference)
      .sort();

    expect(references).toEqual([
      'cc_credentials:cred-owner',
      'cc_credentials:cred-shared',
      'platform_credentials:plat-1',
    ]);
    expect(references).not.toContain('cc_credentials:cred-private-of-member-2');

    const owner = response.credentials.find(
      (c) => c.credentialReference === 'cc_credentials:cred-owner'
    );
    expect(owner).toMatchObject({
      credentialId: 'cred-owner',
      credentialSource: 'user',
      provider: 'anthropic',
      agentType: 'claude-code',
      level: 'critical',
    });
    expect(owner?.windows.map((window) => [window.windowType, window.utilizationPercent])).toEqual([
      ['claude.five_hour', 72],
      ['claude.seven_day', 91],
    ]);

    const shared = response.credentials.find(
      (c) => c.credentialReference === 'cc_credentials:cred-shared'
    );
    expect(shared?.windows[0]).toMatchObject({
      windowType: 'codex.primary',
      windowMinutes: 300,
      source: 'vm-agent.codex_rollout',
      level: 'ok',
    });
    const platform = response.credentials.find(
      (c) => c.credentialReference === 'platform_credentials:plat-1'
    );
    expect(platform?.credentialId).toBeNull();
    expect(typeof response.generatedAt).toBe('number');
  });

  it('excludes rows from other projects and honours the credential filter', async () => {
    const { env, seedWindow } = setup();
    seedWindow({ projectId: 'project-1', credentialReference: 'cc_credentials:a' });
    seedWindow({ projectId: 'project-1', credentialReference: 'cc_credentials:b' });
    seedWindow({ projectId: 'project-2', credentialReference: 'cc_credentials:elsewhere' });

    const all = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'owner-1',
    });
    expect(all.credentials.map((c) => c.credentialReference).sort()).toEqual([
      'cc_credentials:a',
      'cc_credentials:b',
    ]);

    const filtered = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'owner-1',
      credentialReference: 'cc_credentials:b',
    });
    expect(filtered.credentials.map((c) => c.credentialReference)).toEqual(['cc_credentials:b']);
  });

  it('skips a malformed row without dropping the healthy ones (rule 50)', async () => {
    const { env, seedWindow } = setup();
    seedWindow({ credentialReference: 'cc_credentials:good' });
    // createSchemaTables omits CHECK constraints on purpose, so a row the
    // producer could never write can be seeded to prove the reader tolerates it.
    seedWindow({ credentialReference: 'cc_credentials:bad', credentialSource: 'mystery' });

    const response = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'owner-1',
    });
    expect(response.credentials.map((c) => c.credentialReference)).toEqual(['cc_credentials:good']);
  });

  it('caps the number of rows read via CREDENTIAL_LIMIT_READ_MAX_ROWS', async () => {
    const { env, seedWindow } = setup();
    for (let i = 0; i < 5; i++) {
      seedWindow({
        credentialReference: `cc_credentials:c${i}`,
        observedAt: 1_700_000_000_000 + i,
      });
    }
    const response = await listProjectCredentialLimits(
      { ...env, CREDENTIAL_LIMIT_READ_MAX_ROWS: '2' } as Env,
      { projectId: 'project-1', userId: 'owner-1' }
    );
    // Newest observations win when the cap bites.
    expect(response.credentials.map((c) => c.credentialReference)).toEqual([
      'cc_credentials:c4',
      'cc_credentials:c3',
    ]);
  });
});

describe('listUserCredentialLimits', () => {
  it('collapses one credential across projects to the newest sample per window and hides other users', async () => {
    const { env, seedWindow } = setup();
    seedWindow({
      projectId: 'project-1',
      windowType: 'claude.five_hour',
      utilizationPercent: 40,
      observedAt: 1_000,
    });
    seedWindow({
      projectId: 'project-2',
      windowType: 'claude.five_hour',
      utilizationPercent: 65,
      observedAt: 2_000,
    });
    seedWindow({
      projectId: 'project-2',
      windowType: 'claude.seven_day',
      utilizationPercent: 20,
      observedAt: 1_500,
    });
    // Shared credentials are not "mine" — Settings shows personal credentials only.
    seedWindow({
      credentialReference: 'cc_credentials:shared',
      credentialSource: 'project',
      observedAt: 3_000,
    });
    // Another user's personal credential must never appear.
    seedWindow({
      credentialReference: 'cc_credentials:theirs',
      userId: 'member-2',
      observedAt: 4_000,
    });

    const response = await listUserCredentialLimits(env, { userId: 'owner-1' });
    expect(response.credentials).toHaveLength(1);
    const [mine] = response.credentials;
    expect(mine.credentialReference).toBe('cc_credentials:cred-owner');
    expect(mine.observedAt).toBe(2_000);
    expect(mine.windows.map((w) => [w.windowType, w.utilizationPercent, w.observedAt])).toEqual([
      ['claude.five_hour', 65, 2_000],
      ['claude.seven_day', 20, 1_500],
    ]);
  });
});

describe('listUserCredentialLimits cap', () => {
  it('reads at most CREDENTIAL_LIMIT_READ_MAX_ROWS rows, newest first', async () => {
    const { env, seedWindow } = setup();
    for (let i = 0; i < 4; i++) {
      seedWindow({ credentialReference: `cc_credentials:u${i}`, observedAt: 1_000 + i });
    }
    const response = await listUserCredentialLimits(
      { ...env, CREDENTIAL_LIMIT_READ_MAX_ROWS: '2' } as Env,
      { userId: 'owner-1' }
    );
    expect(response.credentials.map((c) => c.credentialReference)).toEqual([
      'cc_credentials:u3',
      'cc_credentials:u2',
    ]);
  });
});

describe('resolveAgentSessionCredentialReference', () => {
  it("returns the reference only when the session's workspace belongs to the project", async () => {
    const { env, seedSession } = setup();
    seedSession({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      projectId: 'project-1',
      credentialReference: 'cc_credentials:cred-owner',
    });
    seedSession({
      sessionId: 'session-2',
      workspaceId: 'ws-2',
      projectId: 'project-1',
      credentialReference: null,
    });

    await expect(
      resolveAgentSessionCredentialReference(env, {
        projectId: 'project-1',
        agentSessionId: 'session-1',
      })
    ).resolves.toBe('cc_credentials:cred-owner');
    // Same session id, foreign project: not found.
    await expect(
      resolveAgentSessionCredentialReference(env, {
        projectId: 'project-9',
        agentSessionId: 'session-1',
      })
    ).resolves.toBeNull();
    // No attribution recorded.
    await expect(
      resolveAgentSessionCredentialReference(env, {
        projectId: 'project-1',
        agentSessionId: 'session-2',
      })
    ).resolves.toBeNull();
  });
});

/**
 * Credential ids created by the 2026-06 composable-credentials backfill embed the
 * legacy ciphertext (`cred-{ownerId}-{ciphertext}:{iv}`), so their references run
 * past the 160-byte budget of a project-event subject id. The producer stores
 * them under a digest key; readers must still find them by the full reference and
 * hand back the real reference and credential id. Rows are written through the
 * real producer so no test computes the key itself (.claude/rules/62).
 */
describe('credential references longer than the identifier budget', () => {
  const ownerCredentialId =
    'cred-4bw1FXkQ7cK2nY8pR3sT6uV9wZ0aB1cD-' +
    'KgCluaQx9+Ga5+i+JTSMVBxORYB/j3L90fcFFZrC4rik9mbQ2'.repeat(3) +
    '/msAieB+gfJsvMulc0mQ==:MPQAR5bNpdU+BnN0';
  const ownerReference = `cc_credentials:${ownerCredentialId}`;
  const memberCredentialId = `${ownerCredentialId.replace('cred-4bw1', 'cred-9zz9')}-member`;
  const memberReference = `cc_credentials:${memberCredentialId}`;

  async function recordWindow(
    env: Env,
    input: {
      credentialReference: string;
      userId: string;
      credentialSource: 'user' | 'project';
      windowType: string;
      utilizationPercent: number;
    }
  ) {
    const now = Date.now();
    const result = await recordCredentialLimitObservation(env, {
      projectId: 'project-1',
      userId: input.userId,
      credentialReference: input.credentialReference,
      credentialSource: input.credentialSource,
      provider: 'anthropic',
      providerMode: 'direct',
      windowType: input.windowType,
      source: 'claude-acp.rate_limit',
      observedAt: now,
      status: 'allowed',
      utilizationPercent: input.utilizationPercent,
      windowMinutes: input.windowType === 'claude.five_hour' ? 300 : 10_080,
      resetsAt: now + 3_600_000,
      agentType: 'claude-code',
    });
    // Below the warning threshold no event is due: the window is stored and the
    // producer reports `ignored: ok` (recorded without an event edge).
    expect(result).toEqual({ outcome: 'ignored', reason: 'ok' });
  }

  function storedReferences(sqlite: Database.Database): string[] {
    return (
      sqlite
        .prepare('SELECT DISTINCT credential_reference FROM credential_limit_windows ORDER BY 1')
        .all() as Array<{ credential_reference: string }>
    ).map((row) => row.credential_reference);
  }

  it('finds the session credential stored under its digest and returns the real reference', async () => {
    expect(new TextEncoder().encode(ownerReference).byteLength).toBeGreaterThan(160);
    const { sqlite, env } = setup();
    sqlite
      .prepare('INSERT INTO cc_credentials (id, owner_id) VALUES (?, ?)')
      .run(ownerCredentialId, 'owner-1');
    await recordWindow(env, {
      credentialReference: ownerReference,
      userId: 'owner-1',
      credentialSource: 'user',
      windowType: 'claude.five_hour',
      utilizationPercent: 13,
    });
    await recordWindow(env, {
      credentialReference: ownerReference,
      userId: 'owner-1',
      credentialSource: 'user',
      windowType: 'claude.seven_day',
      utilizationPercent: 31,
    });
    await recordWindow(env, {
      credentialReference: 'cc_credentials:cred-short',
      userId: 'owner-1',
      credentialSource: 'user',
      windowType: 'claude.five_hour',
      utilizationPercent: 50,
    });

    // The long reference was stored under a digest that fits an event subject id;
    // the short one is stored as itself.
    const stored = storedReferences(sqlite);
    expect(stored).toContain('cc_credentials:cred-short');
    const digest = stored.find((reference) => reference !== 'cc_credentials:cred-short');
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const response = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'owner-1',
      credentialReference: ownerReference,
    });
    expect(response.credentials).toHaveLength(1);
    expect(response.credentials[0]).toMatchObject({
      credentialReference: ownerReference,
      credentialId: ownerCredentialId,
    });
    expect(
      response.credentials[0]!.windows.map((window) => [
        window.windowType,
        window.utilizationPercent,
      ])
    ).toEqual([
      ['claude.five_hour', 13],
      ['claude.seven_day', 31],
    ]);
  });

  it("restores the caller's own credential id on the Settings view", async () => {
    const { sqlite, env } = setup();
    sqlite
      .prepare('INSERT INTO cc_credentials (id, owner_id) VALUES (?, ?), (?, ?)')
      .run(ownerCredentialId, 'owner-1', 'cc-cred-01SHORT', 'owner-1');
    await recordWindow(env, {
      credentialReference: ownerReference,
      userId: 'owner-1',
      credentialSource: 'user',
      windowType: 'claude.five_hour',
      utilizationPercent: 13,
    });
    await recordWindow(env, {
      credentialReference: 'cc_credentials:cc-cred-01SHORT',
      userId: 'owner-1',
      credentialSource: 'user',
      windowType: 'codex.primary',
      utilizationPercent: 65,
    });

    const response = await listUserCredentialLimits(env, { userId: 'owner-1' });
    expect(
      response.credentials.map((credential) => [
        credential.credentialReference,
        credential.credentialId,
      ])
    ).toEqual(
      expect.arrayContaining([
        [ownerReference, ownerCredentialId],
        ['cc_credentials:cc-cred-01SHORT', 'cc-cred-01SHORT'],
      ])
    );
    expect(response.credentials).toHaveLength(2);
  });

  it("keeps another member's credential a digest when the chip resolves their session", async () => {
    const { sqlite, env } = setup();
    sqlite
      .prepare('INSERT INTO cc_credentials (id, owner_id) VALUES (?, ?)')
      .run(memberCredentialId, 'member-2');
    // member-2's session runs on member-2's project-shared credential.
    sqlite
      .prepare(`INSERT INTO workspaces (id, project_id, user_id, status) VALUES (?, ?, ?, ?)`)
      .run('ws-member', 'project-1', 'member-2', 'running');
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, created_at, updated_at, agent_credential_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'agent-session-member',
        'ws-member',
        'member-2',
        'running',
        'claude-code',
        '2026-10-05T00:00:00Z',
        '2026-10-05T00:00:00Z',
        memberReference
      );
    await recordWindow(env, {
      credentialReference: memberReference,
      userId: 'member-2',
      credentialSource: 'project',
      windowType: 'claude.five_hour',
      utilizationPercent: 20,
    });

    // The route's composition: resolve the session within the project, then read.
    const chipRead = async (userId: string) => {
      const credentialReference = await resolveAgentSessionCredentialReference(env, {
        projectId: 'project-1',
        agentSessionId: 'agent-session-member',
      });
      expect(credentialReference).toBe(memberReference);
      return listProjectCredentialLimits(env, {
        projectId: 'project-1',
        userId,
        credentialReference,
      });
    };

    // Another member still sees the shared usage, but not member-2's credential id.
    const asOwner = await chipRead('owner-1');
    expect(asOwner.credentials).toHaveLength(1);
    expect(asOwner.credentials[0]!.windows.map((window) => window.utilizationPercent)).toEqual([
      20,
    ]);
    expect(asOwner.credentials[0]!.credentialId).toBeNull();
    expect(asOwner.credentials[0]!.credentialReference).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Owner control: member-2 gets the real reference and id on the same read.
    const asMember = await chipRead('member-2');
    expect(asMember.credentials).toHaveLength(1);
    expect(asMember.credentials[0]).toMatchObject({
      credentialReference: memberReference,
      credentialId: memberCredentialId,
    });
  });

  it('restores a long credential id for an owner with more credentials than the read cap', async () => {
    const { sqlite, env } = setup();
    env.CREDENTIAL_LIMIT_READ_MAX_ROWS = '2';
    // Modern short ids sort before backfilled `cred-…` ids, so an unfiltered
    // owner lookup capped at two rows would return only short ids.
    sqlite
      .prepare('INSERT INTO cc_credentials (id, owner_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?)')
      .run(
        'cc-cred-01A',
        'owner-1',
        'cc-cred-01B',
        'owner-1',
        'cc-cred-01C',
        'owner-1',
        ownerCredentialId,
        'owner-1'
      );
    await recordWindow(env, {
      credentialReference: ownerReference,
      userId: 'owner-1',
      credentialSource: 'user',
      windowType: 'claude.five_hour',
      utilizationPercent: 13,
    });

    const response = await listUserCredentialLimits(env, { userId: 'owner-1' });
    expect(response.credentials).toHaveLength(1);
    expect(response.credentials[0]).toMatchObject({
      credentialReference: ownerReference,
      credentialId: ownerCredentialId,
    });
  });

  it("never restores another member's credential id, while the owner still gets theirs", async () => {
    const { sqlite, env } = setup();
    sqlite
      .prepare('INSERT INTO cc_credentials (id, owner_id) VALUES (?, ?)')
      .run(memberCredentialId, 'member-2');
    // A project-shared credential owned by member-2: visible to every member.
    await recordWindow(env, {
      credentialReference: memberReference,
      userId: 'member-2',
      credentialSource: 'project',
      windowType: 'claude.five_hour',
      utilizationPercent: 20,
    });

    const asOwner = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'owner-1',
    });
    expect(asOwner.credentials).toHaveLength(1);
    expect(asOwner.credentials[0]!.credentialId).toBeNull();
    expect(asOwner.credentials[0]!.credentialReference).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Owner control: the credential's owner sees its real reference and id.
    const asMember = await listProjectCredentialLimits(env, {
      projectId: 'project-1',
      userId: 'member-2',
    });
    expect(asMember.credentials).toHaveLength(1);
    expect(asMember.credentials[0]).toMatchObject({
      credentialReference: memberReference,
      credentialId: memberCredentialId,
    });
  });
});
