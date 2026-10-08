/**
 * Capability test for Claude credential usage limits, end to end in the Workers
 * runtime: the VM agent's usage callback (real route and schema, real callback
 * JWT, real ProjectData Durable Object, real D1 and KV) through to the two read
 * routes the UI calls — the chat header chip and Settings → Credentials.
 *
 * Production 2026-10-08: every Claude callback returned 400 at the route schema
 * because the echoed credential reference — a credential from the 2026-06
 * composable-credentials backfill, `cc_credentials:cred-{owner}-{ciphertext}:{iv}`,
 * 238 chars — exceeded a 160-char identifier bound, so no Claude window was ever
 * stored. The existing callback tests called the handler directly and never sent a
 * real-length reference through the route (.claude/rules/62).
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { credentialLimitsRoute } from '../../src/routes/credential-limits';
import { projectsRoutes } from '../../src/routes/projects';
import { agentUsageCallbackRoute } from '../../src/routes/projects/agent-usage-callback';
import { signCallbackToken } from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedSignedInUser,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const testEnv = env as unknown as Env;

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError(handleAppError);
  // Callback JWT route mounted before the session-auth project routes, as in index.ts (rule 34).
  hono.route('/api/projects', agentUsageCallbackRoute);
  hono.route('/api/projects', projectsRoutes);
  hono.route('/api/credentials', credentialLimitsRoute);
  return hono;
}

type LimitsBody = {
  credentials: Array<{
    credentialReference: string;
    credentialId: string | null;
    windows: Array<{ windowType: string; utilizationPercent: number | null; status: string }>;
  }>;
};

async function seedClaudeSession(suffix: string, credentialReference: string) {
  const userId = `user-usage-${suffix}`;
  const installationId = `inst-usage-${suffix}`;
  const projectId = `project-usage-${suffix}`;
  const nodeId = `node-usage-${suffix}`;
  const workspaceId = `ws-usage-${suffix}`;
  const agentSessionId = `as-usage-${suffix}`;

  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId);
  const chatSessionId = await projectDataService.createSession(
    testEnv,
    projectId,
    workspaceId,
    'Claude usage limits vertical slice'
  );
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId, status: 'running' });
  await seedAgentSession(agentSessionId, workspaceId, userId, {
    status: 'running',
    agentType: 'claude-code',
  });
  // Server-side attribution the agent-key route records when it hands the VM agent
  // a Claude Max token from a backfilled credential.
  await testEnv.DATABASE.prepare(
    `UPDATE agent_sessions
        SET agent_credential_reference = ?, agent_credential_source = 'user',
            agent_credential_provider = 'agent', agent_provider_mode = 'direct',
            agent_credential_generation = 1
      WHERE id = ?`
  )
    .bind(credentialReference, agentSessionId)
    .run();

  await projectDataService.createAcpSession(
    testEnv,
    projectId,
    chatSessionId,
    'Report Claude usage windows',
    'claude-code',
    null,
    0,
    agentSessionId
  );
  await projectDataService.transitionAcpSession(testEnv, projectId, agentSessionId, 'assigned', {
    actorType: 'system',
    workspaceId,
    nodeId,
  });
  await projectDataService.transitionAcpSession(testEnv, projectId, agentSessionId, 'running', {
    actorType: 'vm-agent',
    actorId: nodeId,
  });

  return {
    userId,
    projectId,
    nodeId,
    agentSessionId,
    callbackToken: await signCallbackToken(workspaceId, testEnv),
  };
}

/** The callback body the VM agent sends for Claude Code's normal reading (two windows). */
function claudeUsageReport(nodeId: string, credentialReference: string) {
  const observedAt = Date.now();
  const window = (windowType: string, utilizationPercent: number, windowMinutes: number) => ({
    windowType,
    provider: 'anthropic',
    source: 'claude-acp.rate_limit',
    status: 'allowed',
    utilizationPercent,
    windowMinutes,
    resetsAt: observedAt + windowMinutes * 30_000,
    observedAt,
    freshnessMs: 0,
  });
  return {
    nodeId,
    agentType: 'claude-code',
    credentialReference,
    credentialSource: 'user',
    credentialGeneration: 1,
    observedAt,
    source: 'claude-acp.usage_update',
    rateLimits: [window('claude.five_hour', 13, 300), window('claude.seven_day', 31, 10_080)],
  };
}

describe('Claude usage limits from the VM agent callback to the UI routes', () => {
  it('stores a backfilled credential reference and shows it on the chat chip and in Settings', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const credentialId =
      `cred-${suffix}xxxxxxxxxxxxxxxxxxxxxxxx-` +
      'KgCluaQx9+Ga5+i+JTSMVBxORYB/j3L90fcFFZrC4rik9mbQ2'.repeat(3) +
      '/msAieB+gfJsvMulc0mQ==:MPQAR5bNpdU+BnN0';
    const credentialReference = `cc_credentials:${credentialId}`;
    expect(credentialReference.length).toBeGreaterThan(160);
    const session = await seedClaudeSession(suffix, credentialReference);
    await testEnv.DATABASE.prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv)
       VALUES (?, ?, 'Claude Max', 'oauth-token', 'ciphertext', 'iv')`
    )
      .bind(credentialId, session.userId)
      .run();

    const callback = await app().request(
      `/api/projects/${session.projectId}/acp-sessions/${session.agentSessionId}/usage`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.callbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(claudeUsageReport(session.nodeId, credentialReference)),
      },
      testEnv
    );
    expect(callback.status, await callback.clone().text()).toBe(204);

    // Stored under a key that fits a project-event subject id.
    const stored = await testEnv.DATABASE.prepare(
      `SELECT credential_reference, window_type, utilization_percent
         FROM credential_limit_windows WHERE project_id = ? ORDER BY window_type`
    )
      .bind(session.projectId)
      .all<{ credential_reference: string; window_type: string; utilization_percent: number }>();
    expect(stored.results.map((row) => [row.window_type, row.utilization_percent])).toEqual([
      ['claude.five_hour', 13],
      ['claude.seven_day', 31],
    ]);
    expect(stored.results[0]!.credential_reference).toMatch(/^sha256:[0-9a-f]{64}$/);

    const cookie = await seedSignedInUser(session.userId);
    const chip = await app().request(
      `/api/projects/${session.projectId}/credential-limits?agentSessionId=${session.agentSessionId}`,
      { headers: { Cookie: cookie } },
      testEnv
    );
    expect(chip.status).toBe(200);
    const chipBody = (await chip.json()) as LimitsBody;
    expect(chipBody.credentials).toHaveLength(1);
    expect(chipBody.credentials[0]).toMatchObject({ credentialReference, credentialId });
    expect(
      chipBody.credentials[0]!.windows.map((window) => [
        window.windowType,
        window.utilizationPercent,
        window.status,
      ])
    ).toEqual([
      ['claude.five_hour', 13, 'allowed'],
      ['claude.seven_day', 31, 'allowed'],
    ]);

    const settings = await app().request(
      '/api/credentials/limits',
      { headers: { Cookie: cookie } },
      testEnv
    );
    expect(settings.status).toBe(200);
    const settingsBody = (await settings.json()) as LimitsBody;
    expect(settingsBody.credentials.map((credential) => credential.credentialId)).toEqual([
      credentialId,
    ]);
  });

  it('still rejects a callback whose echoed reference differs from the server attribution', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const credentialReference = `cc_credentials:cred-${suffix}-${'a'.repeat(200)}`;
    const session = await seedClaudeSession(suffix, credentialReference);

    const forged = await app().request(
      `/api/projects/${session.projectId}/acp-sessions/${session.agentSessionId}/usage`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.callbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          claudeUsageReport(session.nodeId, `cc_credentials:cred-${suffix}-${'b'.repeat(200)}`)
        ),
      },
      testEnv
    );
    expect(forged.status).toBe(403);
    const stored = await testEnv.DATABASE.prepare(
      'SELECT COUNT(*) AS count FROM credential_limit_windows WHERE project_id = ?'
    )
      .bind(session.projectId)
      .first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });
});
