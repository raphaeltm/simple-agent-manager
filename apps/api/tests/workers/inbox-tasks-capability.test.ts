/**
 * Human tasks (inbox slice H1) through the real entry points (`.claude/rules/10`, `.claude/rules/62`):
 * the agent assigns, comments and attaches through the real `/mcp` route; people read and act
 * through the real inbox routes behind the real auth middleware; each change admits a `sam.inbox`
 * event through the real source outbox into the real ProjectData Durable Object, and the wake is
 * materialized the way the ProjectData alarm does it. Only the VM agent HTTP edge is stubbed.
 *
 * Every guard runs on a real SQL engine (D1 and the Durable Object's SQLite).
 */
import { runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { projectMembersRoutes } from '../../src/routes/projects/members';
import { moveDepartedMemberTasksToTeam } from '../../src/services/inbox/departed-member-tasks';
import { storeMcpToken } from '../../src/services/mcp-token';
import { reconcileProjectEventSourceOutbox } from '../../src/services/project-event-source-outbox';
import {
  inboxRows,
  materializeWakes,
  sqlRows,
  withProjectDataEnv,
} from './helpers/agent-message-channels';
import {
  callTool,
  fetchMock,
  get,
  ORIGIN,
  post,
  seed,
  type Seeded,
  testEnv,
} from './helpers/inbox-harness';
import {
  seedAgentSession,
  seedSignedInUser,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

type TaskView = {
  item: { ref: string; kind: string; canAct: boolean; status: string };
  context: unknown;
  task: {
    steps: { index: number; text: string; done: boolean }[];
    assignee: { kind: string; userId: string | null };
    claimedBy: { userId: string } | null;
    activity: { kind: string; actorKind: string }[];
    discussion: { id: string; body: string; replies: { body: string }[] }[];
    canWrite: boolean;
    canClaim: boolean;
  } | null;
};
type ListBody = { items: { ref: string; kind: string; canAct: boolean }[] };

const itemPath = (s: Seeded, ref: string, suffix = '') =>
  `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}${suffix}`;

/** Project-event wakes queued for a chat (the ProjectData prompt inbox). */
async function wakesFor(s: Seeded, sessionId: string) {
  await materializeWakes(s.project, s.projectId);
  const rows = await inboxRows(s.project);
  return rows.filter(
    (row) => row.target_session_id === sessionId && row.source_kind === 'project_event_wake'
  );
}

/**
 * The chat took its queued wakes and the wake cooldown has passed: what the VM agent's acceptance
 * and elapsed time do in production. Without this the materializer holds the next change of the
 * same task behind the cooldown and bundles it into one later wake (by design).
 */
async function deliverWakes(s: Seeded, sessionId: string) {
  await materializeWakes(s.project, s.projectId);
  await sqlRows(
    s.project,
    `DELETE FROM session_inbox WHERE target_session_id = ? AND source_kind = 'project_event_wake'`,
    sessionId
  );
  await sqlRows(
    s.project,
    `UPDATE project_event_delivery_batches SET state = 'acked'
      WHERE target_session_id = ? AND state = 'pending'`,
    sessionId
  );
  await sqlRows(
    s.project,
    `UPDATE project_event_subscriptions SET delivery_cooldown_until = NULL
      WHERE target_session_id = ?`,
    sessionId
  );
}

async function addMember(s: Seeded, role: 'maintainer' | 'viewer', label: string) {
  const userId = `inbox-${label}-${crypto.randomUUID().slice(0, 8)}`;
  await seedUser(userId, { githubId: `gh-${userId}`, name: label });
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, ?, 'active')`
  )
    .bind(s.projectId, userId, role)
    .run();
  return { userId, cookie: await seedSignedInUser(userId) };
}

/** A second running task chat for the owner, with its own agent token. */
async function secondChat(s: Seeded) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspaceId = `inbox-ws2-${suffix}`;
  const taskId = `inbox-task2-${suffix}`;
  const agentSessionId = `inbox-agent2-${suffix}`;
  const sessionId = await s.project.createSession(workspaceId, 'Docs chat', taskId, s.ownerId);
  const node = await testEnv.DATABASE.prepare('SELECT node_id FROM workspaces WHERE id = ?')
    .bind(s.workspaceId)
    .first<{ node_id: string }>();
  await seedWorkspace(workspaceId, node!.node_id, s.ownerId, {
    projectId: s.projectId,
    chatSessionId: sessionId,
    status: 'running',
  });
  await seedTask(taskId, s.projectId, s.ownerId, {
    title: 'Docs task',
    status: 'in_progress',
    taskMode: 'task',
    chatSessionId: sessionId,
  });
  await seedAgentSession(agentSessionId, workspaceId, s.ownerId, { status: 'running' });
  const token = `inbox-token2-${suffix}`;
  await storeMcpToken(testEnv.KV, token, {
    taskId,
    taskMode: 'task',
    projectId: s.projectId,
    userId: s.ownerId,
    workspaceId,
    chatSessionId: sessionId,
    agentSessionId,
    createdAt: new Date().toISOString(),
  });
  return { sessionId, token };
}

async function assign(s: Seeded, args: Record<string, unknown>) {
  const filed = await callTool(s.token, 'inbox_write', { method: 'assign', ...args });
  return filed as { inboxItem: { ref: string; id: string }; created: boolean; watching: boolean };
}

describe('human tasks through the real entry points', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('solo: assigned through MCP, in the assignee inbox only; steps do not wake, a comment and done wake the sleeping chat once each', async () => {
    const s = await seed();
    const stranger = `inbox-stranger-${crypto.randomUUID().slice(0, 8)}`;
    await seedUser(stranger);
    const strangerCookie = await seedSignedInUser(stranger);

    // A non-member assignee is refused, never silently dropped.
    const refused = await testEnvFetchTool(s.token, 'inbox_write', {
      method: 'assign',
      title: 'Add the production Stripe secret',
      assignee: { userId: stranger },
    });
    expect(refused.error?.message).toContain('not an active project member');

    const filed = await assign(s, {
      title: 'Add the production Stripe secret',
      why: 'Only a person can paste it.',
      steps: ['Open Stripe', 'Copy the live key', 'Paste it into Settings'],
      assignee: { userId: s.colleagueId },
      dueHint: 'before Friday',
    });
    expect(filed).toMatchObject({ created: true, watching: true });
    const ref = filed.inboxItem.ref;
    // A retried call files nothing new.
    const retried = await assign(s, {
      title: 'Add the production Stripe secret',
      assignee: { userId: s.colleagueId },
    });
    expect(retried).toMatchObject({ created: false, inboxItem: { ref } });

    // In the assignee's inbox, not in a non-member's.
    const colleagueTasks = await get<ListBody>(
      `/api/projects/${s.projectId}/inbox?filter=tasks`,
      s.colleagueCookie
    );
    expect(colleagueTasks.body.items).toEqual([
      expect.objectContaining({ ref, kind: 'task', canAct: true }),
    ]);
    const strangerView = await get<unknown>(itemPath(s, ref), strangerCookie);
    expect([403, 404]).toContain(strangerView.status);
    const strangerInbox = await get<ListBody>('/api/inbox?filter=tasks', strangerCookie);
    expect(strangerInbox.body.items ?? []).toEqual([]);

    expect(await s.project.sleepSession(s.chatSessionId)).toBe(true);

    // Three quick ticks: recorded, no wake.
    for (const index of [0, 1, 2]) {
      const ticked = await post(itemPath(s, ref, `/steps/${index}`), s.colleagueCookie, {
        done: true,
      });
      expect(ticked.status).toBe(200);
    }
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(0);

    // The assignee's comment wakes the chat once and is labelled as teammate input.
    const commented = await post(itemPath(s, ref, '/comments'), s.colleagueCookie, {
      body: 'Live mode or test mode?',
    });
    expect(commented.status).toBe(200);
    expect(commented.body).toMatchObject({ agentNotified: true });
    const afterComment = await wakesFor(s, s.chatSessionId);
    expect(afterComment).toHaveLength(1);
    expect(afterComment[0]!.content).toContain(`ask:${filed.inboxItem.id}`);
    expect(afterComment[0]!.content).toContain('teammate input');
    expect(afterComment[0]!.content).not.toContain('Live mode or test mode?');
    await deliverWakes(s, s.chatSessionId);

    // The agent answers in the task; the agent's own comment wakes nobody.
    const reply = await callTool(s.token, 'inbox_write', {
      method: 'comment',
      ref,
      body: 'Live mode.',
      threadId: commented.body.threadId,
    });
    expect(reply).toMatchObject({ threadId: commented.body.threadId });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(0);

    const done = await post(itemPath(s, ref, '/done'), s.colleagueCookie, {});
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'done', agentNotified: true });
    const afterDone = await wakesFor(s, s.chatSessionId);
    expect(afterDone).toHaveLength(1);
    expect(afterDone[0]!.content).toContain('marked done');

    // The agent reads the whole task: steps, activity, discussion. No duplicate notice was queued.
    const read = await callTool(s.token, 'inbox_read', { method: 'get', ref });
    const task = read.item as { status: string; task: NonNullable<TaskView['task']> };
    expect(task.status).toBe('done');
    expect(task.task.steps.every((step) => step.done)).toBe(true);
    expect(task.task.activity.map((entry) => entry.kind)).toEqual([
      'created',
      'step_checked',
      'step_checked',
      'step_checked',
      'commented',
      'commented',
      'done',
    ]);
    expect(task.task.discussion).toEqual([
      expect.objectContaining({
        body: 'Live mode or test mode?',
        replies: [expect.objectContaining({ body: 'Live mode.' })],
      }),
    ]);
    const askNotices = await sqlRows(
      s.project,
      `SELECT id FROM session_inbox WHERE source_kind = 'inbox_ask'`
    );
    expect(askNotices).toEqual([]);

    // Reopened: the agent is woken again.
    await deliverWakes(s, s.chatSessionId);
    const reopened = await post(itemPath(s, ref, '/reopen'), s.colleagueCookie, {});
    expect(reopened.body).toMatchObject({ status: 'open', agentNotified: true });
    const afterReopen = await wakesFor(s, s.chatSessionId);
    expect(afterReopen).toHaveLength(1);
    expect(afterReopen[0]!.content).toContain('reopened');
  });

  it('team: one member takes it and it stops needing the others; an attached chat is woken on done', async () => {
    const s = await seed();
    const third = await addMember(s, 'maintainer', 'jonas');
    const docs = await secondChat(s);
    const filed = await assign(s, {
      title: 'Change the DNS record for the launch',
      assignee: { team: true },
    });
    const ref = filed.inboxItem.ref;
    const attached = await callTool(docs.token, 'inbox_write', { method: 'attach', ref });
    expect(attached).toMatchObject({ watching: true, alreadyWatching: false });

    const countBefore = await get<{ needsYou: number }>(
      `/api/projects/${s.projectId}/inbox/count`,
      third.cookie
    );
    expect(countBefore.body.needsYou).toBe(1);

    const claimed = await post(itemPath(s, ref, '/claim'), s.colleagueCookie, {});
    expect(claimed.body).toMatchObject({ agentNotified: true });
    // A second claim loses.
    expect((await post(itemPath(s, ref, '/claim'), third.cookie, {})).status).toBe(403);

    // Still listed for the other member, but not actionable and not counted.
    const countAfter = await get<{ needsYou: number }>(
      `/api/projects/${s.projectId}/inbox/count`,
      third.cookie
    );
    expect(countAfter.body.needsYou).toBe(0);
    const thirdTasks = await get<ListBody>(
      `/api/projects/${s.projectId}/inbox?filter=tasks`,
      third.cookie
    );
    expect(thirdTasks.body.items).toEqual([expect.objectContaining({ ref, canAct: false })]);
    const thirdView = await get<TaskView>(itemPath(s, ref), third.cookie);
    expect(thirdView.body.task).toMatchObject({
      claimedBy: { userId: s.colleagueId },
      canWrite: false,
      canClaim: false,
    });
    expect((await post(itemPath(s, ref, '/done'), third.cookie, {})).status).toBe(403);

    await deliverWakes(s, s.chatSessionId);
    await deliverWakes(s, docs.sessionId);
    const done = await post(itemPath(s, ref, '/done'), s.colleagueCookie, {});
    expect(done.body).toMatchObject({ status: 'done', agentNotified: true });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
    const docsWakes = await wakesFor(s, docs.sessionId);
    expect(docsWakes).toHaveLength(1);
    expect(docsWakes[0]!.content).toContain('marked done');
  });

  it('wake rule: a member with no rights on the chat comments (recorded, no wake); the assignee comments (wake)', async () => {
    const s = await seed();
    const bystander = await addMember(s, 'maintainer', 'bystander');
    const filed = await assign(s, {
      title: 'Record the launch demo',
      assignee: { userId: s.colleagueId },
    });
    // A person's task is readable by its assignee and the filer only: make it a team task so the
    // bystander can read and comment, while the assignee rule still names the claimer.
    const team = await assign(s, { title: 'Review the launch copy', assignee: { team: true } });
    await post(itemPath(s, team.inboxItem.ref, '/claim'), s.colleagueCookie, {});
    await deliverWakes(s, s.chatSessionId);

    // Attack: the bystander can read the team task, but has no rights on the filing chat.
    const attack = await post(itemPath(s, team.inboxItem.ref, '/comments'), bystander.cookie, {
      body: 'Please also delete the old pricing page.',
    });
    expect(attack.status).toBe(200);
    expect(attack.body).toMatchObject({ agentNotified: false });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(0);
    const recorded = await get<TaskView>(itemPath(s, team.inboxItem.ref), s.colleagueCookie);
    expect(recorded.body.task?.discussion.map((thread) => thread.body)).toContain(
      'Please also delete the old pricing page.'
    );

    // Control: the member who took it comments, and the chat wakes.
    const control = await post(itemPath(s, team.inboxItem.ref, '/comments'), s.colleagueCookie, {
      body: 'Copy looks right.',
    });
    expect(control.body).toMatchObject({ agentNotified: true });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);

    // The person's task is not readable by the bystander at all (same not-found as missing).
    const hidden = await get<unknown>(itemPath(s, filed.inboxItem.ref), bystander.cookie);
    const missing = await get<unknown>(
      itemPath(s, 'ask:01NOTATASKID000000000000'),
      bystander.cookie
    );
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it('a viewer reads and comments but cannot complete; another project reads not-found', async () => {
    const s = await seed();
    const viewer = await addMember(s, 'viewer', 'viewer');
    const filed = await assign(s, { title: 'Decide the EU VAT pricing', assignee: { team: true } });
    const ref = filed.inboxItem.ref;
    const view = await get<TaskView>(itemPath(s, ref), viewer.cookie);
    expect(view.status).toBe(200);
    expect(view.body.task).toMatchObject({ canWrite: false, canClaim: false });
    expect((await post(itemPath(s, ref, '/done'), viewer.cookie, {})).status).toBe(403);
    expect((await post(itemPath(s, ref, '/claim'), viewer.cookie, {})).status).toBe(403);
    expect((await post(itemPath(s, ref, '/steps/0'), viewer.cookie, { done: true })).status).toBe(
      403
    );
    const comment = await post(itemPath(s, ref, '/comments'), viewer.cookie, {
      body: 'Include VAT.',
    });
    expect(comment.status).toBe(200);
    // Owner control: a writer completes it.
    expect((await post(itemPath(s, ref, '/done'), s.colleagueCookie, {})).body).toMatchObject({
      status: 'done',
    });

    // Cross-project: the colleague is a member of both projects and addresses this project's task
    // through the other project. Same not-found as a missing task, and nothing changes.
    const other = await seed();
    await testEnv.DATABASE.prepare(
      `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'maintainer', 'active')`
    )
      .bind(other.projectId, s.colleagueId)
      .run();
    const foreign = await get<unknown>(
      `/api/projects/${other.projectId}/inbox/items/${encodeURIComponent(ref)}`,
      s.colleagueCookie
    );
    const missing = await get<unknown>(
      `/api/projects/${other.projectId}/inbox/items/${encodeURIComponent('ask:01NOTATASKID000000000000')}`,
      s.colleagueCookie
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    const foreignReopen = await post(
      `/api/projects/${other.projectId}/inbox/items/${encodeURIComponent(ref)}/reopen`,
      s.colleagueCookie,
      {}
    );
    expect(foreignReopen.status).toBe(404);
    // Owner-path control: the same person, through the right project.
    const own = await get<TaskView>(itemPath(s, ref), s.colleagueCookie);
    expect(own.status).toBe(200);
    expect(own.body.item.status).toBe('done');
  });

  it('edge cases: the assignee leaves (task to the team, agent told); the agent cancels a moot task with a reason', async () => {
    const s = await seed();
    const filed = await assign(s, {
      title: 'Approve the DNS change',
      assignee: { userId: s.colleagueId },
    });
    const ref = filed.inboxItem.ref;
    await deliverWakes(s, s.chatSessionId);
    // The real offboarding routes (preview, then apply as removed), which call the handoff.
    const members = new Hono<{ Bindings: Env }>();
    members.onError(handleAppError);
    members.use('/api/projects/*', requireAuth(), requireApproved());
    members.route('/api/projects', projectMembersRoutes);
    const offboard = (action: string, body?: unknown) =>
      members.request(
        `/api/projects/${s.projectId}/members/${s.colleagueId}/${action}`,
        {
          method: 'POST',
          headers: {
            Cookie: s.ownerCookie,
            Origin: ORIGIN,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        testEnv
      );
    const preview = (await (await offboard('offboarding-preview')).json()) as {
      offboardingPlanId: string;
      canApply: boolean;
    };
    expect(preview.canApply).toBe(true);
    const applied = await offboard('offboarding-apply', {
      planId: preview.offboardingPlanId,
      actions: [],
      finalMemberStatus: 'removed',
    });
    expect(applied.status, await applied.clone().text()).toBe(200);
    // The handoff commits the event to the outbox only; the reconcile sweep admits it.
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(0);
    await reconcileProjectEventSourceOutbox(testEnv);
    const wakes = await wakesFor(s, s.chatSessionId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.content).toContain('SAM reassigned');
    const view = await get<TaskView>(itemPath(s, ref), s.ownerCookie);
    expect(view.body.task).toMatchObject({ assignee: { kind: 'team', userId: null } });
    // Control: a second run of the handoff moves nothing.
    expect(await moveDepartedMemberTasksToTeam(testEnv, s.projectId, s.colleagueId)).toBe(0);

    const moot = await assign(s, {
      title: 'Rotate the old webhook secret',
      assignee: { team: true },
    });
    const cancelled = await callTool(s.token, 'inbox_write', {
      method: 'cancel',
      ref: moot.inboxItem.ref,
      reason: 'Found a way to do it without a person.',
    });
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    const after = await get<TaskView>(itemPath(s, moot.inboxItem.ref), s.ownerCookie);
    expect(after.body.item.status).toBe('cancelled');
    expect(after.body.task).toMatchObject({
      cancelReason: 'Found a way to do it without a person.',
    });
    expect(after.body.task?.activity.map((entry) => entry.kind)).toEqual(['created', 'cancelled']);
  });

  it('task discussion shows on the project Comments page only for people who may read the task', async () => {
    const s = await seed();
    const bystander = await addMember(s, 'maintainer', 'bystander');
    const mine = await assign(s, {
      title: 'Sign the vendor contract',
      assignee: { userId: s.colleagueId },
    });
    const team = await assign(s, { title: 'Pick the launch date', assignee: { team: true } });
    await post(itemPath(s, mine.inboxItem.ref, '/comments'), s.colleagueCookie, {
      body: 'Signed copy?',
    });
    await post(itemPath(s, team.inboxItem.ref, '/comments'), s.colleagueCookie, {
      body: 'Tuesday?',
    });
    await post(itemPath(s, mine.inboxItem.ref, '/comments'), s.colleagueCookie, {
      body: 'This newer private thread must not consume the bystander page.',
    });
    type Comments = {
      inboxItemThreads: { itemId: string; body: string }[];
      inboxItems: { ref: string; title: string }[];
      totalCount: number;
      hasMore: boolean;
    };
    const assignee = await get<Comments>(
      `/api/projects/${s.projectId}/comments`,
      s.colleagueCookie
    );
    expect(assignee.body.inboxItemThreads.map((thread) => thread.body).sort()).toEqual([
      'Signed copy?',
      'This newer private thread must not consume the bystander page.',
      'Tuesday?',
    ]);
    const other = await get<Comments>(
      `/api/projects/${s.projectId}/comments?limit=1`,
      bystander.cookie
    );
    expect(other.status).toBe(200);
    expect(other.body.inboxItemThreads.map((thread) => thread.body)).toEqual(['Tuesday?']);
    expect(other.body.inboxItems).toEqual([
      { ref: team.inboxItem.ref, id: team.inboxItem.id, title: 'Pick the launch date' },
    ]);
    expect(other.body.totalCount).toBe(1);
    expect(other.body.hasMore).toBe(false);
  });

  it('reassign: to a member (notified, claim released), back to the team; a non-member is refused and nothing changes', async () => {
    const s = await seed();
    const third = await addMember(s, 'maintainer', 'priya');
    const filed = await assign(s, { title: 'Book the launch venue', assignee: { team: true } });
    const ref = filed.inboxItem.ref;
    await post(itemPath(s, ref, '/claim'), s.colleagueCookie, {});
    await deliverWakes(s, s.chatSessionId);

    const stranger = `inbox-out-${crypto.randomUUID().slice(0, 8)}`;
    await seedUser(stranger);
    const refused = await post(itemPath(s, ref, '/reassign'), s.colleagueCookie, {
      assigneeUserId: stranger,
    });
    expect(refused.status).toBe(400);
    const unchanged = await get<TaskView>(itemPath(s, ref), s.colleagueCookie);
    expect(unchanged.body.task).toMatchObject({
      assignee: { kind: 'team' },
      claimedBy: { userId: s.colleagueId },
    });

    const toPriya = await post(itemPath(s, ref, '/reassign'), s.colleagueCookie, {
      assigneeUserId: third.userId,
    });
    expect(toPriya.body).toMatchObject({ status: 'open', agentNotified: true });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
    const priyaView = await get<TaskView>(itemPath(s, ref), third.cookie);
    expect(priyaView.body.task).toMatchObject({
      assignee: { kind: 'user', userId: third.userId },
      claimedBy: null,
      canWrite: true,
    });
    // The previous claimer no longer sees it (a person's task is the assignee's and the filer's).
    expect((await get<unknown>(itemPath(s, ref), s.colleagueCookie)).status).toBe(404);

    await deliverWakes(s, s.chatSessionId);
    const toTeam = await post(itemPath(s, ref, '/reassign'), third.cookie, { team: true });
    expect(toTeam.body).toMatchObject({ agentNotified: true });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
  });

  it('archive through the inbox route closes a task and wakes no one; untick is recorded; wakeOnSteps makes ticks wake', async () => {
    const s = await seed();
    const filed = await assign(s, {
      title: 'Check the invoice totals',
      steps: ['Open the report', 'Compare totals'],
      assignee: { userId: s.colleagueId },
      wakeOnSteps: true,
    });
    const ref = filed.inboxItem.ref;
    await deliverWakes(s, s.chatSessionId);
    await post(itemPath(s, ref, '/steps/0'), s.colleagueCookie, { done: true });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
    await deliverWakes(s, s.chatSessionId);
    const untick = await post(itemPath(s, ref, '/steps/0'), s.colleagueCookie, { done: false });
    expect(untick.status).toBe(200);
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
    // Ticking a step already in that state changes nothing.
    const again = await post(itemPath(s, ref, '/steps/0'), s.colleagueCookie, { done: false });
    expect(again.body).toMatchObject({ agentNotified: false });
    expect(
      (await post(itemPath(s, ref, '/steps/7'), s.colleagueCookie, { done: true })).status
    ).toBe(400);
    // A segment that is not a whole number never addresses a step (`parseInt('0junk')` is 0).
    expect(
      (await post(itemPath(s, ref, '/steps/0junk'), s.colleagueCookie, { done: true })).status
    ).toBe(400);

    await deliverWakes(s, s.chatSessionId);
    const archived = await post(itemPath(s, ref, '/archive'), s.colleagueCookie, {});
    expect(archived.status).toBe(200);
    // Archive tells no watcher (every inbox archive is silent; Raphaël, 2026-11-17). The step
    // ticks above prove this chat does get woken by a task event when one is sent.
    expect(archived.body).toMatchObject({ outcome: 'archived', agentNotified: false });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(0);
    const settled = await testEnv.DATABASE.prepare('SELECT notified_at FROM asks WHERE id = ?')
      .bind(filed.inboxItem.id)
      .first<{ notified_at: number | null }>();
    expect(settled?.notified_at).not.toBeNull();
    // No event wound the watch down, so the archive does: it expires after the closed-task grace.
    const watches = await sqlRows<{ expires_at: number | null }>(
      s.project,
      `SELECT expires_at FROM project_event_subscriptions WHERE target_session_id = ?`,
      s.chatSessionId
    );
    expect(watches).toHaveLength(1);
    expect(watches[0]!.expires_at).toBeGreaterThan(Date.now());
    const view = await get<TaskView>(itemPath(s, ref), s.colleagueCookie);
    expect(view.body.task?.activity.map((entry) => entry.kind)).toEqual([
      'created',
      'step_checked',
      'step_unchecked',
      'archived',
    ]);
    // Reopening is engaging with it again, so it does wake the chat.
    await deliverWakes(s, s.chatSessionId);
    expect((await post(itemPath(s, ref, '/reopen'), s.colleagueCookie, {})).body).toMatchObject({
      status: 'open',
    });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
  });

  it('attach: only a chat of the same person; an attached chat is woken by lifecycle changes, not by comments', async () => {
    const s = await seed();
    const docs = await secondChat(s);
    const filed = await assign(s, {
      title: 'Approve the pricing copy',
      assignee: { userId: s.colleagueId },
    });
    const ref = filed.inboxItem.ref;
    // A second chat of the same person may watch a task assigned to a teammate.
    expect(await callTool(docs.token, 'inbox_write', { method: 'attach', ref })).toMatchObject({
      watching: true,
    });
    // A chat of another person may not, even on a team task it can read.
    const team = await assign(s, { title: 'Pick a launch tweet', assignee: { team: true } });
    const other = await seed();
    await testEnv.DATABASE.prepare(
      `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'maintainer', 'active')`
    )
      .bind(s.projectId, other.ownerId)
      .run();
    const foreignChat = await testEnvFetchTool(other.token, 'inbox_write', {
      method: 'attach',
      ref: team.inboxItem.ref,
    });
    expect(foreignChat.error).toBeDefined();

    await deliverWakes(s, s.chatSessionId);
    await deliverWakes(s, docs.sessionId);
    const commented = await post(itemPath(s, ref, '/comments'), s.colleagueCookie, {
      body: 'Is the EU price right?',
    });
    expect(commented.body).toMatchObject({ agentNotified: true });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
    expect(await wakesFor(s, docs.sessionId)).toHaveLength(0);
    await deliverWakes(s, s.chatSessionId);
    await post(itemPath(s, ref, '/done'), s.colleagueCookie, {});
    expect(await wakesFor(s, docs.sessionId)).toHaveLength(1);
  });

  it('a task open for days still wakes: each change renews the watch past its lifetime and wake budget', async () => {
    const s = await seed();
    const filed = await assign(s, { title: 'Sign the DPA', assignee: { userId: s.colleagueId } });
    const ref = filed.inboxItem.ref;
    await deliverWakes(s, s.chatSessionId);
    // Two days later, with the generic wake lifetime long over and the budget spent.
    await sqlRows(
      s.project,
      `UPDATE project_event_subscriptions
          SET delivery_lifetime_expires_at = ?, prompt_delivery_count = 1000
        WHERE target_session_id = ?`,
      Date.now() - 1,
      s.chatSessionId
    );
    await post(itemPath(s, ref, '/comments'), s.colleagueCookie, { body: 'Which entity signs?' });
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
    // Done: the watch winds down (expires after the grace) instead of holding a place forever.
    await deliverWakes(s, s.chatSessionId);
    await post(itemPath(s, ref, '/done'), s.colleagueCookie, {});
    expect(await wakesFor(s, s.chatSessionId)).toHaveLength(1);
    const watches = await sqlRows<{ expires_at: number | null }>(
      s.project,
      `SELECT expires_at FROM project_event_subscriptions WHERE target_session_id = ?`,
      s.chatSessionId
    );
    expect(watches).toHaveLength(1);
    expect(watches[0]!.expires_at).toBeGreaterThan(Date.now());
  });

  it('a direct event subscription to sam.inbox is refused; inbox_write is the only way to watch', async () => {
    const s = await seed();
    const refused = await testEnvFetchTool(s.token, 'create_project_event_subscription', {
      idempotencyKey: 'sneak',
      filter: { version: 1, source: 'sam.inbox' },
      requestedDelivery: 'record_only',
    });
    expect(refused.error?.message ?? JSON.stringify(refused)).toContain('inbox_write');
    // Control: a subscription to another source still works.
    const allowed = await callTool(s.token, 'create_project_event_subscription', {
      idempotencyKey: 'lifecycle',
      filter: { version: 1, source: 'sam.lifecycle' },
      requestedDelivery: 'record_only',
    });
    expect(allowed).toBeTruthy();
  });

  it('two members take a team task at once: exactly one wins and one claim is recorded', async () => {
    const s = await seed();
    const third = await addMember(s, 'maintainer', 'sam');
    const filed = await assign(s, { title: 'Renew the domain', assignee: { team: true } });
    const ref = filed.inboxItem.ref;
    const results = await Promise.all([
      post(itemPath(s, ref, '/claim'), s.colleagueCookie, {}),
      post(itemPath(s, ref, '/claim'), third.cookie, {}),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status !== 200)).toHaveLength(1);
    const view = await get<TaskView>(itemPath(s, ref), s.ownerCookie);
    expect(view.body.task?.activity.filter((entry) => entry.kind === 'claimed')).toHaveLength(1);
    expect(view.body.task?.claimedBy).not.toBeNull();
  });

  it("the filing chat's work finished: the task stays open and its changes are recorded, not delivered", async () => {
    const s = await seed();
    const filed = await assign(s, {
      title: 'Confirm the invoice address',
      assignee: { userId: s.colleagueId },
    });
    const ref = filed.inboxItem.ref;
    await deliverWakes(s, s.chatSessionId);
    // The real alarm path (it checks the source task before materializing a wake).
    const alarmWakes = async () => {
      await withProjectDataEnv(s.project, { PROJECT_EVENT_WAKE_ENABLED: 'true' }, () =>
        runInDurableObject(s.project, (instance) =>
          (
            instance as unknown as { runProjectEventWakeMaterializationAlarm(): Promise<void> }
          ).runProjectEventWakeMaterializationAlarm()
        )
      );
      return (await inboxRows(s.project)).filter(
        (row) =>
          row.target_session_id === s.chatSessionId && row.source_kind === 'project_event_wake'
      );
    };
    // Control: while the chat's task is running, the alarm delivers a comment's wake.
    await post(itemPath(s, ref, '/comments'), s.colleagueCookie, { body: 'Head office?' });
    expect(await alarmWakes()).toHaveLength(1);
    await deliverWakes(s, s.chatSessionId);

    await testEnv.DATABASE.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`)
      .bind(s.taskId)
      .run();
    const commented = await post(itemPath(s, ref, '/comments'), s.colleagueCookie, {
      body: 'Which office?',
    });
    expect(commented.status).toBe(200);
    const view = await get<TaskView>(itemPath(s, ref), s.colleagueCookie);
    expect(view.body.item.status).toBe('open');
    expect(view.body.task?.discussion.map((thread) => thread.body)).toEqual([
      'Head office?',
      'Which office?',
    ]);
    // The event is recorded ...
    const events = await sqlRows<{ id: string }>(
      s.project,
      `SELECT id FROM project_events WHERE source = 'sam.inbox' AND subject_id = ?`,
      filed.inboxItem.id
    );
    expect(events.length).toBe(2);
    // ... but the alarm does not wake a chat whose task finished.
    expect(await alarmWakes()).toHaveLength(0);
  });
});

async function testEnvFetchTool(token: string, name: string, args: Record<string, unknown>) {
  const { SELF } = await import('cloudflare:test');
  const response = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-raw`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return response.json<{ error?: { message: string } }>();
}
