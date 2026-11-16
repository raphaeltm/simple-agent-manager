/**
 * Insights slice U end to end in the Workers runtime: the VM agent's token report (the exact
 * payload the Go builder produces, pinned by `vm-agent-usage-report-token-usage.json` on both
 * sides, rule 23) through the real usage callback route, schema, callback JWT, ProjectData binding
 * and D1 migration 0253, to the run receipt route the UI reads.
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import contractFixture from '../../../../packages/shared/tests/fixtures/vm-agent-usage-report-token-usage.json';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { projectsRoutes } from '../../src/routes/projects';
import { agentUsageCallbackRoute } from '../../src/routes/projects/agent-usage-callback';
import { tasksRoutes } from '../../src/routes/tasks';
import { seedSignedInUser, seedTask } from './helpers/seed-d1';
import { seedClaudeSession } from './helpers/usage-callback-session';

const testEnv = env as unknown as Env;

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError(handleAppError);
  // Callback JWT route mounted before the session-auth project routes, as in index.ts (rule 34).
  hono.route('/api/projects', agentUsageCallbackRoute);
  hono.route('/api/projects/:projectId/tasks', tasksRoutes);
  hono.route('/api/projects', projectsRoutes);
  return hono;
}

type Session = Awaited<ReturnType<typeof seedClaudeSession>>;

function postUsage(session: Session, body: unknown) {
  return app().request(
    `/api/projects/${session.projectId}/acp-sessions/${session.agentSessionId}/usage`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.callbackToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

/** The Go contract fixture, addressed to this session's node and credential. */
function goTokenReport(session: Session, credentialReference: string) {
  return { ...contractFixture, nodeId: session.nodeId, credentialReference, credentialGeneration: 1 };
}

async function storedRows(projectId: string) {
  const result = await testEnv.DATABASE.prepare(
    `SELECT chat_session_id, source, model, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, reasoning_tokens, credential_key
       FROM agent_run_usage WHERE project_id = ? ORDER BY model`
  )
    .bind(projectId)
    .all<Record<string, unknown>>();
  return result.results;
}

describe('run token usage from the VM agent callback to the receipt', () => {
  it('stores the Go payload once per report and shows it on the run receipt', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const credentialReference = `cc_credentials:cred-run-usage-${suffix}`;
    const session = await seedClaudeSession(suffix, credentialReference);

    const first = await postUsage(session, goTokenReport(session, credentialReference));
    expect(first.status, await first.clone().text()).toBe(204);
    // The same report again (a retry): counted once.
    const retry = await postUsage(session, goTokenReport(session, credentialReference));
    expect(retry.status).toBe(204);

    const rows = await storedRows(session.projectId);
    expect(rows).toEqual([
      {
        chat_session_id: session.chatSessionId,
        source: 'harness',
        model: '',
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 12,
        credential_key: credentialReference,
      },
      {
        chat_session_id: session.chatSessionId,
        source: 'harness',
        model: 'claude-opus-5-5',
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_tokens: 56000,
        cache_write_tokens: 7800,
        reasoning_tokens: null,
        credential_key: credentialReference,
      },
    ]);

    const taskId = `task-run-usage-${suffix}`;
    await seedTask(taskId, session.projectId, session.userId, {
      status: 'completed',
      chatSessionId: session.chatSessionId,
      workspaceId: session.workspaceId,
    });
    const cookie = await seedSignedInUser(session.userId);
    const receipt = await app().request(
      `/api/projects/${session.projectId}/tasks/${taskId}/receipt`,
      { headers: { Cookie: cookie } },
      testEnv
    );
    expect(receipt.status, await receipt.clone().text()).toBe(200);
    const body = (await receipt.json()) as { tokens: Record<string, unknown> };
    expect(body.tokens).toMatchObject({
      state: 'reported',
      source: 'harness',
      total: { input: 1210, output: 342, cacheRead: 56000, cacheWrite: 7800, reasoning: 12 },
      // No cc_credentials row names this key, so the account kind is unknown: tokens, no money.
      spend: { state: 'unknown_account' },
    });
  });

  it('keeps an old agent’s report (no tokenUsage) working and writes no usage', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const credentialReference = `cc_credentials:cred-run-usage-old-${suffix}`;
    const session = await seedClaudeSession(suffix, credentialReference);
    const { tokenUsage: _omitted, ...legacy } = goTokenReport(session, credentialReference);
    const observedAt = Date.now();
    const response = await postUsage(session, {
      ...legacy,
      source: 'claude-acp.usage_update',
      rateLimits: [
        {
          windowType: 'claude.five_hour',
          provider: 'anthropic',
          source: 'claude-acp.rate_limit',
          status: 'allowed',
          utilizationPercent: 20,
          windowMinutes: 300,
          resetsAt: observedAt + 3_600_000,
          observedAt,
          freshnessMs: 0,
        },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(204);
    expect(await storedRows(session.projectId)).toEqual([]);
    const windows = await testEnv.DATABASE.prepare(
      'SELECT COUNT(*) AS count FROM credential_limit_windows WHERE project_id = ?'
    )
      .bind(session.projectId)
      .first<{ count: number }>();
    expect(windows?.count).toBe(1);
  });

  it('refuses a report for another project’s session and stores nothing', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const credentialReference = `cc_credentials:cred-run-usage-a-${suffix}`;
    const victim = await seedClaudeSession(`v${suffix}`, credentialReference);
    const attacker = await seedClaudeSession(`a${suffix}`, credentialReference);
    // The attacker's own valid token, addressed at the victim's project and session.
    const forged = await app().request(
      `/api/projects/${victim.projectId}/acp-sessions/${victim.agentSessionId}/usage`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${attacker.callbackToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(goTokenReport(victim, credentialReference)),
      },
      testEnv
    );
    expect(forged.status).toBe(403);
    expect(await storedRows(victim.projectId)).toEqual([]);
    // Owner control: the victim's own token is accepted.
    expect((await postUsage(victim, goTokenReport(victim, credentialReference))).status).toBe(204);
    expect(await storedRows(victim.projectId)).toHaveLength(2);
  });
});
