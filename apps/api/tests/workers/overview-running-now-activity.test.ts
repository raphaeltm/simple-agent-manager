/**
 * Running now reads "is the agent mid-turn" from the ProjectData activity mirror, through the
 * real Overview route, the real ProjectData object and the real D1 index (rule 62, rule 74).
 *
 * Incident (2026-11-20): Running now said "Nothing is running" while ten SAM chats were awake and
 * streaming. Its predicate keyed on `tasks.execution_step <> 'awaiting_followup'` and
 * `agent_completed_at IS NULL`; the step latches at `awaiting_followup` after a chat's first turn
 * and nothing writes `agent_completed_at`, so only first-turn chats were ever listed.
 */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import type { ProjectOverviewResponse } from '@simple-agent-manager/shared';
import { runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { projectOverviewRoutes } from '../../src/routes/project-overview';
import { seed, type Seeded, testEnv } from './helpers/inbox-harness';

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError(handleAppError);
  hono.use('/api/*', requireAuth(), requireApproved());
  hono.route('/api/projects/:projectId/overview', projectOverviewRoutes);
  return hono;
}

async function runningIds(s: Seeded): Promise<string[]> {
  // The D1 index is written on a debounce; flush it the way the timer would.
  await runInDurableObject(s.project, async (instance) => {
    await (instance as unknown as { runSummarySyncLocked(): Promise<void> }).runSummarySyncLocked();
  });
  const response = await app().request(
    `/api/projects/${s.projectId}/overview`,
    { headers: { Cookie: s.ownerCookie } },
    testEnv,
    executionCtx
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as ProjectOverviewResponse;
  expect(body.unavailable).not.toContain('running');
  return body.running.items.map((chat) => chat.sessionId);
}

/** The task as every chat past its first turn has it: the step latched at awaiting_followup. */
async function latchFollowupStep(s: Seeded) {
  await testEnv.DATABASE.prepare(
    `UPDATE tasks SET execution_step = 'awaiting_followup' WHERE id = ?`
  )
    .bind(s.taskId)
    .run();
}

async function newAgentSession(project: DurableObjectStub<ProjectData>, chatSessionId: string) {
  const acp = await project.createAcpSession({
    chatSessionId,
    initialPrompt: null,
    agentType: 'claude-code',
  });
  // ACP sessions order by creation time; keep a later one strictly later.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return acp.id;
}

describe('Running now follows the agent activity mirror', () => {
  it('lists a later-turn chat while its agent is prompting and drops it when the turn ends', async () => {
    const s = await seed();
    await latchFollowupStep(s);
    const acpId = await newAgentSession(s.project, s.chatSessionId);

    await s.project.reportActivity(acpId, 'prompting');
    expect(await runningIds(s)).toEqual([s.chatSessionId]);

    // Control: the same chat, turn over. It is awake and its task is in progress, but idle.
    await s.project.reportActivity(acpId, 'idle');
    expect(await runningIds(s)).toEqual([]);

    // A recovering agent is still working.
    await s.project.reportActivity(acpId, 'recovering');
    expect(await runningIds(s)).toEqual([s.chatSessionId]);
  });

  it('reads the newest agent session, as the chat view does: an older stuck row does not count', async () => {
    const s = await seed();
    const older = await newAgentSession(s.project, s.chatSessionId);
    await s.project.reportActivity(older, 'prompting');
    const newer = await newAgentSession(s.project, s.chatSessionId);
    await s.project.reportActivity(newer, 'idle');
    expect(await runningIds(s)).toEqual([]);

    // Control: the newest session working lists the chat.
    await s.project.reportActivity(newer, 'prompting');
    expect(await runningIds(s)).toEqual([s.chatSessionId]);
  });

  it('falls back to the chat-keyed row when the chat has no agent session yet', async () => {
    const s = await seed();
    await s.project.reportActivity(s.chatSessionId, 'prompting');
    expect(await runningIds(s)).toEqual([s.chatSessionId]);
    await s.project.reportActivity(s.chatSessionId, 'stopped');
    expect(await runningIds(s)).toEqual([]);
  });

  it('never lists a sleeping chat, whatever its last activity row says', async () => {
    const s = await seed();
    const acpId = await newAgentSession(s.project, s.chatSessionId);
    await s.project.reportActivity(acpId, 'prompting');
    expect(await runningIds(s)).toEqual([s.chatSessionId]);

    await runInDurableObject(s.project, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE chat_sessions SET status = 'sleeping', updated_at = ? WHERE id = ?`,
        Date.now(),
        s.chatSessionId
      );
    });
    expect(await s.project.listWorkingChatSessionIds()).toEqual([]);
    expect(await runningIds(s)).toEqual([]);
  });
});
