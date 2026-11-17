/**
 * Insights · People through the real entry points (`.claude/rules/10`, `.claude/rules/62`): an
 * agent files a question and human tasks through the real `/mcp` route, people hand a task on and
 * finish tasks through the real Inbox routes behind the real auth middleware, and the People read
 * is fetched through the real `/insights/people` route. Every value the tab shows here was written
 * by the production writers, on the Workers runtime's D1.
 */
import type { ProjectPeopleResponse } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { projectInsightsRoutes } from '../../src/routes/project-insights';
import { callTool, fetchMock, post, seed, type Seeded, testEnv } from './helpers/inbox-harness';

function insightsApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use('/api/*', requireAuth(), requireApproved());
  app.route('/api/projects/:projectId/insights', projectInsightsRoutes);
  return app;
}

async function people(s: Seeded, cookie: string): Promise<ProjectPeopleResponse> {
  const response = await insightsApp().request(
    `/api/projects/${s.projectId}/insights/people?range=7d`,
    { headers: { Cookie: cookie } },
    testEnv
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  return response.json<ProjectPeopleResponse>();
}

const itemPath = (s: Seeded, ref: string, suffix = '') =>
  `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}${suffix}`;

async function assign(s: Seeded, args: Record<string, unknown>): Promise<string> {
  const filed = (await callTool(s.token, 'inbox_write', { method: 'assign', ...args })) as {
    inboxItem: { ref: string };
  };
  return filed.inboxItem.ref;
}

describe('Insights · People through the real entry points', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows what waits on whom, hands a task on through the Inbox route, and counts first-person answers', async () => {
    const s = await seed();
    // The agent (the owner's run) asks the owner a question and files three tasks.
    await callTool(s.token, 'request_human_input', {
      context: 'Should the refund job run hourly?',
      category: 'decision',
      options: ['Hourly', 'Daily'],
    });
    const forColleague = await assign(s, {
      title: 'Check the refund totals',
      assignee: { userId: s.colleagueId },
    });
    const secondForColleague = await assign(s, {
      title: 'Update the refund runbook',
      assignee: { userId: s.colleagueId },
    });
    const forTeam = await assign(s, { title: 'Pick a release date', assignee: { team: true } });

    const before = await people(s, s.ownerCookie);
    expect(before.unavailable).toEqual([]);
    expect(before.waiting.total).toBe(4);
    const byKey = Object.fromEntries(before.waiting.groups.map((g) => [g.key, g]));
    expect(byKey[s.colleagueId]).toMatchObject({ kind: 'person', open: 2, you: false });
    // The owner's run filed these, so the owner may read them and hand them on (Inbox rule).
    expect(byKey[s.colleagueId]!.items.map((i) => [i.ref, i.title, i.canReassign])).toEqual([
      [forColleague, 'Check the refund totals', true],
      [secondForColleague, 'Update the refund runbook', true],
    ]);
    expect(byKey[s.ownerId]).toMatchObject({ you: true, open: 1, blocking: 1 });
    expect(byKey[s.ownerId]!.items[0]).toMatchObject({ kind: 'question', canReassign: false });
    expect(byKey.unassigned!.items[0]).toMatchObject({ ref: forTeam, canReassign: true });

    // The colleague hands the first task to the owner through the Inbox's own route.
    const moved = await post(itemPath(s, forColleague, '/reassign'), s.colleagueCookie, {
      assigneeUserId: s.ownerId,
    });
    expect(moved.status).toBe(200);
    const after = await people(s, s.ownerCookie);
    const afterByKey = Object.fromEntries(after.waiting.groups.map((g) => [g.key, g]));
    expect(afterByKey[s.colleagueId]!.items.map((i) => i.ref)).toEqual([secondForColleague]);
    expect(afterByKey[s.ownerId]!.items.map((i) => i.ref)).toContain(forColleague);

    // The colleague finishes the task they were first given; the owner finishes the handed-on
    // one; the owner finishes the team task (first asked: the team, so it does not count).
    expect((await post(itemPath(s, secondForColleague, '/done'), s.colleagueCookie)).status).toBe(
      200
    );
    expect((await post(itemPath(s, forColleague, '/done'), s.ownerCookie)).status).toBe(200);
    expect((await post(itemPath(s, forTeam, '/done'), s.ownerCookie)).status).toBe(200);

    const done = await people(s, s.ownerCookie);
    expect(done.firstPerson).toEqual({ closed: 2, firstPerson: 1, share: 0.5 });
    expect(done.waiting.total).toBe(1); // the question is still open
    // The colleague sees the owner's question only as its age.
    const asColleague = await people(s, s.colleagueCookie);
    const ownerGroup = asColleague.waiting.groups.find((g) => g.key === s.ownerId)!;
    expect(ownerGroup.items[0]).toMatchObject({
      private: true,
      ref: null,
      title: null,
      kind: null,
      blocking: null,
    });
    expect(JSON.stringify(asColleague)).not.toContain('refund job');
  });
});
