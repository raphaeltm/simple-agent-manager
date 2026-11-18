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
import { invalidateAdminSettings } from '../../src/services/admin-settings';
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

function postUsage(session: Session, body: unknown, bindings = testEnv) {
  return app().request(
    `/api/projects/${session.projectId}/acp-sessions/${session.agentSessionId}/usage`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.callbackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    bindings
  );
}

/** The Go contract fixture, addressed to this session's node and credential. */
function goTokenReport(session: Session, credentialReference: string) {
  return {
    ...contractFixture,
    nodeId: session.nodeId,
    credentialReference,
    credentialGeneration: 1,
  };
}

async function withUsageCap(
  maxRows: number,
  run: (session: Session, report: ReturnType<typeof goTokenReport>, suffix: string) => Promise<void>
) {
  await testEnv.DATABASE.prepare(
    "INSERT INTO platform_settings (key, value, updated_at) VALUES ('insights.runUsageMaxRowsPerSession', ?, ?)"
  )
    .bind(String(maxRows), new Date().toISOString())
    .run();
  invalidateAdminSettings(testEnv);
  try {
    const suffix = crypto.randomUUID().slice(0, 8);
    const reference = `cc_credentials:capped-${suffix}`;
    const session = await seedClaudeSession(suffix, reference);
    await run(session, goTokenReport(session, reference), suffix);
  } finally {
    await testEnv.DATABASE.prepare(
      "DELETE FROM platform_settings WHERE key = 'insights.runUsageMaxRowsPerSession'"
    ).run();
    invalidateAdminSettings(testEnv);
  }
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

  it('bounds fresh callback epochs without blocking an admitted epoch update', async () => {
    await withUsageCap(2, async (session, report) => {
      expect((await postUsage(session, report)).status).toBe(204);
      expect(
        (
          await postUsage(session, {
            ...report,
            tokenUsage: {
              epoch: 'host-fedcba987654321001234567',
              models: [{ model: 'new-model', inputTokens: 1, outputTokens: 1 }],
            },
          })
        ).status
      ).toBe(204);
      expect(
        (
          await postUsage(session, {
            ...report,
            tokenUsage: {
              epoch: contractFixture.tokenUsage.epoch,
              models: [{ model: 'claude-opus-5-5', inputTokens: 1300, outputTokens: 350 }],
            },
          })
        ).status
      ).toBe(204);

      const rows = await storedRows(session.projectId);
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual(
        expect.objectContaining({
          model: 'claude-opus-5-5',
          input_tokens: 1300,
          output_tokens: 350,
        })
      );
      expect(rows).not.toContainEqual(expect.objectContaining({ model: 'new-model' }));
    });
  });

  it('concurrent fresh epochs compete for the final row slot through real callbacks', async () => {
    await withUsageCap(3, async (session, report, suffix) => {
      expect((await postUsage(session, report)).status).toBe(204); // two rows, one slot remains
      const responses = await Promise.all(
        Array.from({ length: 17 }, (_, index) =>
          postUsage(session, {
            ...report,
            tokenUsage: {
              epoch: `host-${index.toString(16).padStart(24, '0')}`,
              models: [{ model: 'race-model', inputTokens: 1, outputTokens: 1 }],
            },
          })
        )
      );
      expect(responses.map((response) => response.status)).toEqual(Array(17).fill(204));
      expect(await storedRows(session.projectId)).toHaveLength(3);
      expect(
        (
          await postUsage(session, {
            ...report,
            tokenUsage: {
              epoch: contractFixture.tokenUsage.epoch,
              models: [
                { model: 'claude-opus-5-5', inputTokens: 1700, outputTokens: 400 },
                { model: 'novel-mixed', inputTokens: 1, outputTokens: 1 },
              ],
            },
            source: 'claude-acp.usage_update',
            rateLimits: [
              {
                windowType: 'claude.five_hour',
                provider: 'anthropic',
                source: 'claude-acp.rate_limit',
                status: 'allowed',
                utilizationPercent: 30,
                windowMinutes: 300,
                resetsAt: Date.now() + 3600000,
                observedAt: Date.now(),
                freshnessMs: 0,
              },
            ],
          })
        ).status
      ).toBe(204);
      const rows = await storedRows(session.projectId);
      expect(rows).toHaveLength(3);
      expect(rows).toContainEqual(
        expect.objectContaining({
          model: 'claude-opus-5-5',
          input_tokens: 1700,
          output_tokens: 400,
        })
      );
      expect(rows).not.toContainEqual(expect.objectContaining({ model: 'novel-mixed' }));
      const window = await testEnv.DATABASE.prepare(
        'SELECT utilization_percent FROM credential_limit_windows WHERE project_id = ?'
      )
        .bind(session.projectId)
        .first<{ utilization_percent: number }>();
      expect(window?.utilization_percent).toBe(30);
      const taskId = `task-cap-${suffix}`;
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
      expect(receipt.status).toBe(200);
      expect(await receipt.json()).toMatchObject({
        tokens: { state: 'reported', limited: true, total: { input: 1711, output: 403 } },
      });
    });
  });

  it('shows an incomplete receipt when the real callback admits none of a multi-model report', async () => {
    await withUsageCap(1, async (session, report, suffix) => {
      expect((await postUsage(session, report)).status).toBe(204);
      expect(await storedRows(session.projectId)).toHaveLength(0);
      const taskId = `task-marker-${suffix}`;
      await seedTask(taskId, session.projectId, session.userId, {
        status: 'completed',
        chatSessionId: session.chatSessionId,
        workspaceId: session.workspaceId,
      });
      const cookie = await seedSignedInUser(session.userId);
      const response = await app().request(
        `/api/projects/${session.projectId}/tasks/${taskId}/receipt`,
        { headers: { Cookie: cookie } },
        testEnv
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        tokens: { state: 'not_reported', limited: true },
      });
      const marker = await testEnv.DATABASE.prepare(
        'SELECT COUNT(*) AS n FROM agent_run_usage_admission_hits WHERE project_id=? AND chat_session_id=?'
      )
        .bind(session.projectId, session.chatSessionId)
        .first<{ n: number }>();
      expect(marker?.n).toBe(1);
    });
  });

  it('keeps the token-report callback within the mutation I/O budget', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const reference = `cc_credentials:budget-${suffix}`;
    const session = await seedClaudeSession(suffix, reference);
    let roundTrips = 0;
    const database = new Proxy(testEnv.DATABASE, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            const observe = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(value, method) {
                  if (method === 'bind')
                    return (...args: unknown[]) => observe(value.bind(...args));
                  if (['run', 'all', 'first', 'raw'].includes(String(method)))
                    return (...args: unknown[]) => {
                      roundTrips++;
                      return Reflect.apply(Reflect.get(value, method), value, args);
                    };
                  return Reflect.get(value, method);
                },
              });
            return observe(target.prepare(query));
          };
        const value = Reflect.get(target, property);
        if (property === 'batch')
          return (...args: unknown[]) => {
            roundTrips++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const namespace = new Proxy(testEnv.PROJECT_DATA, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'get' || property === 'getByName')
          return (...args: unknown[]) => {
            const stub = Reflect.apply(value, target, args);
            return new Proxy(stub, {
              get(object, method) {
                const rpc = Reflect.get(object, method);
                return typeof rpc === 'function'
                  ? (...params: unknown[]) => {
                      roundTrips++;
                      return Reflect.apply(rpc, object, params);
                    }
                  : rpc;
              },
            });
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    invalidateAdminSettings({ ...testEnv, DATABASE: database });
    const response = await postUsage(
      session,
      {
        ...goTokenReport(session, reference),
        source: 'claude-acp.usage_update',
        rateLimits: [
          {
            windowType: 'claude.five_hour',
            provider: 'anthropic',
            source: 'claude-acp.rate_limit',
            status: 'allowed',
            utilizationPercent: 30,
            windowMinutes: 300,
            resetsAt: Date.now() + 3600000,
            observedAt: Date.now(),
            freshnessMs: 0,
          },
        ],
      },
      { ...testEnv, DATABASE: database, PROJECT_DATA: namespace }
    );
    expect(response.status).toBe(204);
    // All D1 statements/batches and ProjectData RPCs are observed; KV rate limiting is separate.
    expect(roundTrips).toBeLessThanOrEqual(12);
    expect(await storedRows(session.projectId)).toHaveLength(2);
  });

  it('keeps an old agent’s report (no tokenUsage) working and writes no usage', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const credentialReference = `cc_credentials:cred-run-usage-old-${suffix}`;
    const session = await seedClaudeSession(suffix, credentialReference);
    const legacy: Record<string, unknown> = { ...goTokenReport(session, credentialReference) };
    delete legacy.tokenUsage;
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
        headers: {
          Authorization: `Bearer ${attacker.callbackToken}`,
          'Content-Type': 'application/json',
        },
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
