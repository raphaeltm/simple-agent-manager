/**
 * `project_insights` through the real /mcp route (Insights slice I): the real token check, the
 * real D1 schema from the migration chain, and the real `McpRateCounter` Durable Object.
 *
 * - Contract: every method answers through the route with the token's project.
 * - Identity (rule 51): one person owns projects A and B; a token for A asking for B is refused,
 *   and B's rows never reach A's answers, while the owner path for A succeeds beside each attack.
 * - Rate limit (rule 28 §4): the call after the budget is refused, invalid input does not spend
 *   it, and the next window admits again.
 */
import { INSIGHTS_AGENT_SETTINGS } from '@simple-agent-manager/operations';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import {
  consumeProjectInsightsBudget,
  handleProjectInsights,
  projectInsightsRateKey,
} from '../../src/routes/mcp/project-insights-tool';
import { resolveAdminSettingDetailsMany } from '../../src/services/admin-settings-resolution';
import { storeMcpToken } from '../../src/services/mcp-token';
import {
  seedInstallation,
  seedMcpTokenWorkspace,
  seedProject,
  seedTask,
  seedUser,
} from './helpers/seed-d1';

interface RpcResponse {
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

const PREFIX = `mcp-insights-${Date.now()}`;
const userId = `${PREFIX}-user`;
const projectA = `${PREFIX}-project-a`;
const projectB = `${PREFIX}-project-b`;
const taskA = `${PREFIX}-task-a`;
const taskB = `${PREFIX}-task-b`;
const SKILL = `${PREFIX}-skill`;
const otherUserId = `${PREFIX}-other-user`;
const projectC = `${PREFIX}-project-c`;
let tokenSeq = 0;

async function tokenFor(projectId: string, chatSessionId?: string): Promise<string> {
  tokenSeq += 1;
  const token = `${PREFIX}-token-${tokenSeq}`;
  await seedMcpTokenWorkspace(`${token}-ws`, userId, projectId);
  await storeMcpToken(env.KV, token, {
    taskId: `${token}-task`,
    projectId,
    userId,
    workspaceId: `${token}-ws`,
    chatSessionId: chatSessionId ?? `${token}-chat`,
    createdAt: new Date().toISOString(),
  });
  return token;
}

async function post(token: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch('https://api.test.example.com/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'insights',
      method: 'tools/call',
      params: { name: 'project_insights', arguments: args },
    }),
  });
}

async function call(token: string, args: Record<string, unknown>): Promise<RpcResponse> {
  const response = await post(token, args);
  expect(response.status).toBe(200);
  return response.json<RpcResponse>();
}

function data(response: RpcResponse): Record<string, unknown> {
  expect(response.error).toBeUndefined();
  const text = response.result?.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text as string) as Record<string, unknown>;
}

async function seedPhase(projectId: string, phase: string, durationMs: number): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO lifecycle_phase_timings
       (operation, phase, outcome, duration_ms, project_id, skill_id, created_at)
     VALUES ('workspace', ?, 'success', ?, ?, ?, ?)`
  )
    .bind(phase, durationMs, projectId, SKILL, Date.now() - 60_000)
    .run();
}

beforeAll(async () => {
  await seedUser(userId, { githubId: `${PREFIX}-gh` });
  await seedInstallation(`${PREFIX}-inst`, userId, { installationIdValue: `${PREFIX}-ext` });
  await seedProject(projectA, userId, `${PREFIX}-inst`, { repository: `${PREFIX}/a` });
  await seedProject(projectB, userId, `${PREFIX}-inst`, { repository: `${PREFIX}/b` });
  const completed = { status: 'completed', completedAt: new Date().toISOString() };
  await seedTask(taskA, projectA, userId, { ...completed, title: 'A task title' });
  await seedTask(taskB, projectB, userId, { ...completed, title: 'B task title' });
  await seedPhase(projectA, 'git_clone', 40);
  await seedPhase(projectA, 'git_clone', 60);
  // Same skill id, same phase, another project of the same person.
  await seedPhase(projectB, 'git_clone', 900_000);
  await seedPhase(projectB, 'volume_create', 5);
  // Project C belongs to someone else; the token's user is not a member.
  await seedUser(otherUserId, { githubId: `${PREFIX}-gh-other` });
  await seedInstallation(`${PREFIX}-inst-other`, otherUserId, {
    installationIdValue: `${PREFIX}-ext-other`,
  });
  await seedProject(projectC, otherUserId, `${PREFIX}-inst-other`, { repository: `${PREFIX}/c` });
  await seedPhase(projectC, 'git_clone', 7);
});

describe('project_insights through /mcp', () => {
  it('answers every method with the token project', async () => {
    const token = await tokenFor(projectA);

    const receipt = data(await call(token, { method: 'receipt', taskId: taskA }));
    expect(receipt).toMatchObject({ method: 'receipt', projectId: projectA });
    expect(receipt.receipt).toMatchObject({ taskId: taskA, status: 'completed' });
    expect(JSON.stringify(receipt)).not.toContain('A task title');

    const flow = data(await call(token, { method: 'flow', range: '7d' }));
    expect(flow).toMatchObject({ method: 'flow', projectId: projectA, flow: { range: '7d' } });

    const setups = data(await call(token, { method: 'setups', groupBy: 'skill' }));
    expect(setups).toMatchObject({ setups: { range: '30d', groupBy: 'skill' } });

    const accounts = data(await call(token, { method: 'accounts' }));
    expect(accounts).toMatchObject({ method: 'accounts', accounts: { range: '30d' } });

    const bOnlyPhase = data(
      await call(token, { method: 'phases', skillId: SKILL, phaseNames: ['volume_create'] })
    );
    expect(bOnlyPhase.phases).toMatchObject({ stats: [] });
    const phases = data(await call(token, { method: 'phases', skillId: SKILL }));
    expect(phases.phases).toMatchObject({
      stats: [{ operation: 'workspace', phase: 'git_clone', count: 2, medianMs: 40, p90Ms: 60 }],
    });
  });

  it('refuses a project other than the token project, beside the owner path', async () => {
    const token = await tokenFor(projectA);
    const attack = await call(token, { method: 'flow', projectId: projectB });
    expect(attack.result).toBeUndefined();
    expect(attack.error?.message).toBe('Project does not match workspace token');

    const owner = data(await call(token, { method: 'flow', projectId: projectA }));
    expect(owner.projectId).toBe(projectA);
  });

  it('never returns another project rows reached by id, beside the owner path', async () => {
    const token = await tokenFor(projectA);
    const foreignTask = await call(token, { method: 'receipt', taskId: taskB });
    expect(foreignTask.result).toBeUndefined();
    expect(foreignTask.error?.message).toBe('Task not found');
    // A foreign task is indistinguishable from a task that does not exist.
    const missing = await call(token, { method: 'receipt', taskId: `${PREFIX}-no-such-task` });
    expect(missing.error).toEqual(foreignTask.error);
    expect(data(await call(token, { method: 'receipt', taskId: taskA })).receipt).toMatchObject({
      taskId: taskA,
    });

    // B's token sees B's rows only, under the same skill id.
    const tokenB = await tokenFor(projectB);
    const phasesB = data(await call(tokenB, { method: 'phases', skillId: SKILL }));
    expect(phasesB.phases).toMatchObject({
      stats: [
        { phase: 'git_clone', count: 1, medianMs: 900_000 },
        { phase: 'volume_create', count: 1 },
      ],
    });
  });

  it.each([
    { method: 'receipt', taskId: taskA },
    { method: 'flow' },
    { method: 'setups' },
    { method: 'phases', skillId: SKILL },
    { method: 'accounts' },
  ])(
    'refuses $method for a project the token user is not a member of, even with its own token',
    async (args) => {
      // A token naming project C for a non-member is refused at MCP authentication, before the
      // tool runs (the membership check in authorizeProjectOperation is the second layer).
      const token = await tokenFor(projectC);
      const refused = await post(token, args);
      expect(refused.status).toBe(401);
      expect(await refused.text()).not.toContain('git_clone');
      // Owner control: the same user's own project answers.
      const own = await tokenFor(projectA);
      expect((await call(own, args)).error).toBeUndefined();
    }
  );

  it('fails closed when the rate counter cannot be reached, without reading', async () => {
    const workerEnv = { ...(env as unknown as Env), MCP_RATE_COUNTER: undefined };
    const response = await handleProjectInsights(
      'r1',
      { method: 'phases', skillId: SKILL },
      {
        taskId: '',
        projectId: projectA,
        userId,
        workspaceId: `${PREFIX}-fail-closed-ws`,
        chatSessionId: `${PREFIX}-fail-closed-chat`,
        createdAt: new Date().toISOString(),
      },
      workerEnv
    );
    expect(response).toMatchObject({
      error: { code: -32603, message: 'project_insights is temporarily unavailable' },
    });
    expect('result' in response && response.result).toBeFalsy();
  });

  it('two tokens for one chat share one budget', async () => {
    const chat = `${PREFIX}-shared-chat`;
    const first = await tokenFor(projectA, chat);
    const second = await tokenFor(projectA, chat);
    const budget = INSIGHTS_AGENT_SETTINGS[0].defaultValue;
    for (let i = 0; i < budget; i += 1) {
      expect(
        (await call(i % 2 ? first : second, { method: 'phases', skillId: SKILL })).error
      ).toBeUndefined();
    }
    expect((await call(first, { method: 'phases', skillId: SKILL })).error?.code).toBe(-32000);
  });

  it('refuses the call after the per-chat budget, without spending it on invalid input', async () => {
    const token = await tokenFor(projectA);
    const budget = INSIGHTS_AGENT_SETTINGS[0].defaultValue;
    // Invalid input is refused before the budget is touched.
    const invalid = await call(token, { method: 'nope' });
    expect(invalid.error?.message).toBe('Invalid method');

    for (let i = 0; i < budget; i += 1) {
      const ok = await call(token, { method: 'phases', skillId: SKILL });
      expect(ok.error).toBeUndefined();
    }
    const refused = await call(token, { method: 'phases', skillId: SKILL });
    expect(refused.error?.code).toBe(-32000);
    expect(refused.error?.message).toMatch(/rate limit reached for this chat; retry after \d+s/);

    // Another chat has its own budget.
    const other = await tokenFor(projectA);
    expect((await call(other, { method: 'phases', skillId: SKILL })).error).toBeUndefined();
  });
});

describe('consumeProjectInsightsBudget', () => {
  it('admits up to the limit, refuses the next call, and admits again in the next window', async () => {
    const workerEnv = env as unknown as Env;
    const key = projectInsightsRateKey({
      taskId: '',
      projectId: projectA,
      userId,
      workspaceId: `${PREFIX}-rollover-ws`,
      chatSessionId: `${PREFIX}-rollover-chat`,
      createdAt: new Date().toISOString(),
    });
    expect(key).toBe(`project_insights:chat:${PREFIX}-rollover-chat`);
    // An hour-long window, so the Durable Object's own clock cannot cross the boundary mid-test.
    const limit = { callsPerWindow: 2, windowSeconds: 3600 };
    const windowStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;

    expect((await consumeProjectInsightsBudget(workerEnv, key, limit, windowStart)).allowed).toBe(
      true
    );
    expect(
      (await consumeProjectInsightsBudget(workerEnv, key, limit, windowStart + 1_000)).allowed
    ).toBe(true);
    const third = await consumeProjectInsightsBudget(workerEnv, key, limit, windowStart + 2_000);
    expect(third).toMatchObject({ allowed: false, resetAt: windowStart / 1000 + 3600 });

    const next = await consumeProjectInsightsBudget(workerEnv, key, limit, windowStart + 3_600_000);
    expect(next).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('reads both limits from the admin settings registry', async () => {
    const names = INSIGHTS_AGENT_SETTINGS.map((setting) => setting.name);
    await env.DATABASE.batch(
      names.map((name, i) =>
        env.DATABASE.prepare(
          'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)'
        ).bind(name, String(i === 0 ? 7 : 120), new Date().toISOString())
      )
    );
    try {
      const values = await resolveAdminSettingDetailsMany(env as unknown as Env, names, {
        fresh: true,
      });
      expect(values.map((value) => [value.value, value.source])).toEqual([
        [7, 'database'],
        [120, 'database'],
      ]);
    } finally {
      await env.DATABASE.prepare(
        `DELETE FROM platform_settings WHERE key IN (${names.map(() => '?').join(',')})`
      )
        .bind(...names)
        .run();
      await resolveAdminSettingDetailsMany(env as unknown as Env, names, { fresh: true });
    }
  });

  it('charges a chat, else the agent session, else the workspace', () => {
    const base = { taskId: 't', projectId: 'p', userId: 'u', workspaceId: 'w', createdAt: 'c' };
    expect(projectInsightsRateKey({ ...base, agentSessionId: 'a' })).toBe(
      'project_insights:agent:a'
    );
    expect(projectInsightsRateKey(base)).toBe('project_insights:workspace:w');
  });
});
