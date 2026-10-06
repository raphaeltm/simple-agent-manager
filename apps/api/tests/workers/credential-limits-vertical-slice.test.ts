/**
 * Vertical slice for credential usage-limit reads: real Hono app, real BetterAuth
 * session cookie, real D1 (Miniflare), real project membership middleware.
 *
 * The unit tests prove the SQL predicate on an in-memory SQLite engine; this
 * proves the route + auth + membership + service compose the same way end to end
 * (.claude/rules/35, .claude/rules/10).
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { credentialLimitsRoute } from '../../src/routes/credential-limits';
import { projectsRoutes } from '../../src/routes/projects';
import {
  seedAgentSession,
  seedInstallation,
  seedProject,
  seedSignedInUser,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const testEnv = env as unknown as Env;

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError(handleAppError);
  hono.route('/api/projects', projectsRoutes);
  hono.route('/api/credentials', credentialLimitsRoute);
  return hono;
}

type WindowSeed = {
  projectId: string;
  userId: string;
  credentialReference: string;
  credentialSource: 'user' | 'project' | 'platform';
  windowType: string;
  utilizationPercent: number;
  observedAt: number;
};

async function seedWindow(seed: WindowSeed): Promise<void> {
  await testEnv.DATABASE.prepare(
    `INSERT OR REPLACE INTO credential_limit_windows (
       project_id, credential_reference, window_type, credential_source, provider, provider_mode,
       agent_type, user_id, source, status, last_event_level, utilization_percent, window_minutes,
       resets_at, observed_at, freshness_ms, duplicate_sample_count, stale_sample_count,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'anthropic', 'direct', 'claude-code', ?, 'claude-acp.rate_limit',
       'allowed', 'ok', ?, 300, ?, ?, 0, 0, 0, ?, ?)`
  )
    .bind(
      seed.projectId,
      seed.credentialReference,
      seed.windowType,
      seed.credentialSource,
      seed.userId,
      seed.utilizationPercent,
      seed.observedAt + 3_600_000,
      seed.observedAt,
      seed.observedAt,
      seed.observedAt
    )
    .run();
}

async function addMember(projectId: string, userId: string): Promise<void> {
  await testEnv.DATABASE.prepare(
    `INSERT OR IGNORE INTO project_members (project_id, user_id, role, status, created_at, updated_at)
     VALUES (?, ?, 'maintainer', 'active', datetime('now'), datetime('now'))`
  )
    .bind(projectId, userId)
    .run();
}

type LimitsBody = {
  credentials: Array<{ credentialReference: string; windows: Array<{ windowType: string }> }>;
};

function references(body: LimitsBody): string[] {
  return body.credentials.map((credential) => credential.credentialReference).sort();
}

describe('credential usage limits vertical slice', () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = `owner-${suffix}`;
  const member = `member-${suffix}`;
  const outsider = `outsider-${suffix}`;
  const projectId = `proj-${suffix}`;
  const otherProjectId = `proj-other-${suffix}`;
  const workspaceId = `ws-${suffix}`;
  const agentSessionId = `as-${suffix}`;
  const now = Date.now() - 60_000;

  beforeEach(async () => {
    await seedUser(owner);
    await seedUser(member);
    await seedUser(outsider);
    await seedInstallation(`inst-${suffix}`, owner);
    await seedProject(projectId, owner, `inst-${suffix}`);
    await seedProject(otherProjectId, owner, `inst-${suffix}`);
    await addMember(projectId, member);
    await seedWorkspace(workspaceId, null, owner, { projectId });
    await seedAgentSession(agentSessionId, workspaceId, owner, { agentType: 'claude-code' });
    await testEnv.DATABASE.prepare(
      `UPDATE agent_sessions SET agent_credential_reference = ?, agent_credential_source = 'user' WHERE id = ?`
    )
      .bind(`cc_credentials:owner-${suffix}`, agentSessionId)
      .run();

    // Owner's personal credential, two windows.
    await seedWindow({ projectId, userId: owner, credentialReference: `cc_credentials:owner-${suffix}`, credentialSource: 'user', windowType: 'claude.five_hour', utilizationPercent: 72, observedAt: now });
    await seedWindow({ projectId, userId: owner, credentialReference: `cc_credentials:owner-${suffix}`, credentialSource: 'user', windowType: 'claude.seven_day', utilizationPercent: 31, observedAt: now - 1_000 });
    // Member's PERSONAL credential: visible to the member, never to the owner.
    await seedWindow({ projectId, userId: member, credentialReference: `cc_credentials:member-${suffix}`, credentialSource: 'user', windowType: 'claude.five_hour', utilizationPercent: 99, observedAt: now });
    // Project-shared credential: visible to every member.
    await seedWindow({ projectId, userId: member, credentialReference: `cc_credentials:shared-${suffix}`, credentialSource: 'project', windowType: 'claude.five_hour', utilizationPercent: 12, observedAt: now });
    // Owner's personal credential in ANOTHER project: only the user-level route shows it.
    await seedWindow({ projectId: otherProjectId, userId: owner, credentialReference: `cc_credentials:owner-elsewhere-${suffix}`, credentialSource: 'user', windowType: 'claude.five_hour', utilizationPercent: 5, observedAt: now });
  });

  it('scopes the project view per caller through the real auth and membership stack', async () => {
    const ownerCookie = await seedSignedInUser(owner);
    const ownerResponse = await app().request(
      `/api/projects/${projectId}/credential-limits`,
      { headers: { Cookie: ownerCookie } },
      testEnv
    );
    const ownerText = await ownerResponse.clone().text();
    expect(ownerResponse.status, ownerText).toBe(200);
    expect(references((await ownerResponse.json()) as LimitsBody)).toEqual([
      `cc_credentials:owner-${suffix}`,
      `cc_credentials:shared-${suffix}`,
    ]);

    const memberCookie = await seedSignedInUser(member);
    const memberResponse = await app().request(
      `/api/projects/${projectId}/credential-limits`,
      { headers: { Cookie: memberCookie } },
      testEnv
    );
    expect(memberResponse.status).toBe(200);
    expect(references((await memberResponse.json()) as LimitsBody)).toEqual([
      `cc_credentials:member-${suffix}`,
      `cc_credentials:shared-${suffix}`,
    ]);
  });

  it('rejects non-members and unauthenticated callers before reading any window', async () => {
    const outsiderCookie = await seedSignedInUser(outsider);
    const forbidden = await app().request(
      `/api/projects/${projectId}/credential-limits`,
      { headers: { Cookie: outsiderCookie } },
      testEnv
    );
    expect([403, 404]).toContain(forbidden.status);

    const anonymous = await app().request(`/api/projects/${projectId}/credential-limits`, {}, testEnv);
    expect(anonymous.status).toBe(401);
  });

  it('narrows to the agent session credential and ignores sessions from other projects', async () => {
    const ownerCookie = await seedSignedInUser(owner);
    const narrowed = await app().request(
      `/api/projects/${projectId}/credential-limits?agentSessionId=${agentSessionId}`,
      { headers: { Cookie: ownerCookie } },
      testEnv
    );
    expect(narrowed.status).toBe(200);
    const body = (await narrowed.json()) as LimitsBody;
    expect(references(body)).toEqual([`cc_credentials:owner-${suffix}`]);
    expect(body.credentials[0]!.windows.map((window) => window.windowType)).toEqual([
      'claude.five_hour',
      'claude.seven_day',
    ]);

    const foreign = await app().request(
      `/api/projects/${otherProjectId}/credential-limits?agentSessionId=${agentSessionId}`,
      { headers: { Cookie: ownerCookie } },
      testEnv
    );
    expect(foreign.status).toBe(200);
    expect(((await foreign.json()) as LimitsBody).credentials).toEqual([]);
  });

  it('serves the caller\'s personal credentials across projects at /api/credentials/limits', async () => {
    const ownerCookie = await seedSignedInUser(owner);
    const response = await app().request(
      '/api/credentials/limits',
      { headers: { Cookie: ownerCookie } },
      testEnv
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as LimitsBody;
    expect(references(body)).toEqual([
      `cc_credentials:owner-${suffix}`,
      `cc_credentials:owner-elsewhere-${suffix}`,
    ]);
  });
});
