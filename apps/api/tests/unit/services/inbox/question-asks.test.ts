/**
 * Agent questions held in D1 `asks` (inbox slice G), on a real SQL engine (`.claude/rules/28`,
 * `.claude/rules/11`): filing through `request_human_input`'s create path, the answer
 * compare-and-set and its caller outcomes, concurrent answers, tenancy (attack cases paired with
 * owner controls), the typed-chat-message close, and the sweep's reminders, undelivered grace and
 * expiry. Replaced edges only: ProjectData RPCs (prompt delivery, live events, expiry outcome),
 * the agent-wake policy, the shared-answer audit and push receipts.
 */
import { answerInboxItem, archiveInboxItem } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  acceptPromptDelivery: vi.fn(),
  recordQuestionAsked: vi.fn(),
  expireQuestionAsk: vi.fn(),
  getSessionAccess: vi.fn(),
  prepareAttentionAnswer: vi.fn(),
  authorizeAgentWake: vi.fn(),
  recordSharedSessionAnswer: vi.fn(),
  hasConfirmedPushDelivery: vi.fn(),
  resendPush: vi.fn(),
}));
vi.mock('../../../../src/services/project-data', async () => ({
  ...(await vi.importActual<typeof import('../../../../src/services/project-data')>(
    '../../../../src/services/project-data'
  )),
  acceptPromptDelivery: edges.acceptPromptDelivery,
  recordQuestionAsked: edges.recordQuestionAsked,
  expireQuestionAsk: edges.expireQuestionAsk,
  getSessionAccess: edges.getSessionAccess,
  prepareAttentionAnswer: edges.prepareAttentionAnswer,
}));
vi.mock('../../../../src/services/agent-wake-authorization', () => ({
  authorizeAgentWake: edges.authorizeAgentWake,
}));
vi.mock('../../../../src/services/session-access', async () => ({
  ...(await vi.importActual<typeof import('../../../../src/services/session-access')>(
    '../../../../src/services/session-access'
  )),
  recordSharedSessionAnswer: edges.recordSharedSessionAnswer,
}));
vi.mock('../../../../src/project-data-ports/notifications', () => ({
  notificationsPort: {
    hasConfirmedPushDelivery: edges.hasConfirmedPushDelivery,
    resendPush: edges.resendPush,
  },
}));
vi.mock('../../../../src/middleware/auth', () => ({ getUserId: () => 'owner' }));

import { closeQuestionAsksForHumanMessage } from '@simple-agent-manager/project-data/internal/do/question-asks';

import * as schema from '../../../../src/db/schema';
import type { Env } from '../../../../src/env';
import { createOperationPorts } from '../../../../src/operation-ports';
import { answerAttention, registerChatAttentionRoute } from '../../../../src/routes/chat-attention';
import {
  fileQuestionAsk,
  linkQuestionNotification,
} from '../../../../src/services/inbox/question-asks';
import { runInboxAskSweep } from '../../../../src/services/inbox/sweep';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../../helpers/sqlite-d1';

const P1 = 'proj-1';
const P2 = 'proj-2';
const MINUTE = 60_000;
let sqlite: Database.Database;
let env: Env;

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

function askRow(id: string) {
  return sqlite.prepare('SELECT * FROM asks WHERE id = ?').get(id) as Record<string, unknown>;
}

function setting(key: string, value: string) {
  insert('platform_settings', { key, value, updated_at: '2026-11-16T00:00:00Z' });
}

const question = (overrides: Partial<Parameters<typeof fileQuestionAsk>[1]> = {}) =>
  fileQuestionAsk(env, {
    projectId: P1,
    sessionId: 'chat-1',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    userId: 'owner',
    context: 'Which region should the deploy use? EU keeps latency low for our users.',
    category: 'decision',
    options: ['eu', 'us'],
    ...overrides,
  });

beforeEach(() => {
  vi.useRealTimers();
  for (const edge of Object.values(edges)) edge.mockReset();
  edges.acceptPromptDelivery.mockResolvedValue({ message: { id: 'd' } });
  edges.recordQuestionAsked.mockResolvedValue(undefined);
  edges.expireQuestionAsk.mockResolvedValue({ outcome: 'expired' });
  edges.getSessionAccess.mockResolvedValue({
    session: { topic: 'Deploy chat' },
    access: { found: true, role: 'owner', ownerUserId: 'owner' },
  });
  edges.prepareAttentionAnswer.mockResolvedValue({ status: 'not_found' });
  edges.authorizeAgentWake.mockResolvedValue({
    writer: { ownerUserId: 'owner', role: 'owner' },
    wake: { allowed: true },
  });
  edges.recordSharedSessionAnswer.mockResolvedValue(undefined);
  edges.hasConfirmedPushDelivery.mockResolvedValue(false);
  edges.resendPush.mockResolvedValue(undefined);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec('DROP TABLE asks');
  applySqliteMigration(
    sqlite,
    new URL('../../../../src/db/migrations/0245_asks.sql', import.meta.url)
  );
  applySqliteMigration(
    sqlite,
    new URL('../../../../src/db/migrations/0247_asks_questions.sql', import.meta.url)
  );
  env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
  for (const id of ['owner', 'outsider'])
    insert('users', { id, email: `${id}@x.test`, name: id, role: 'user', status: 'active' });
  insert('projects', { id: P1, user_id: 'owner', name: 'One', repository: 'o/one' });
  insert('projects', { id: P2, user_id: 'outsider', name: 'Two', repository: 'o/two' });
  insert('project_members', { project_id: P1, user_id: 'owner', role: 'owner', status: 'active' });
  insert('project_members', {
    project_id: P2,
    user_id: 'outsider',
    role: 'owner',
    status: 'active',
  });
  insert('tasks', {
    id: 'task-1',
    project_id: P1,
    user_id: 'owner',
    title: 'Deploy',
    status: 'in_progress',
    chat_session_id: 'chat-1',
  });
  insert('tasks', {
    id: 'task-2',
    project_id: P2,
    user_id: 'outsider',
    title: 'Other',
    status: 'in_progress',
    chat_session_id: 'chat-2',
  });
});

describe('filing a question (request_human_input)', () => {
  it('writes one asks row with the question, its options and today’s schedule, and shows it live', async () => {
    const before = Date.now();
    const filed = await question();
    const row = askRow(filed.id);
    expect(row).toMatchObject({
      project_id: P1,
      kind: 'question',
      blocking: 1,
      assignee_kind: 'user',
      assignee_user_id: 'owner',
      status: 'open',
      title: 'Which region should the deploy use?',
      body_md: 'Which region should the deploy use? EU keeps latency low for our users.',
      category: 'decision',
      source_session_id: 'chat-1',
      source_task_id: 'task-1',
      source_workspace_id: 'ws-1',
      escalation_count: 0,
      notified_at: null,
    });
    expect(JSON.parse(String(row.answer_spec_json))).toEqual({
      type: 'options',
      options: ['eu', 'us'],
      allowText: false,
    });
    // Defaults: a 2 h window, reminders at 25 % and 75 %, a 24 h hard limit.
    const created = Number(row.created_at);
    expect(created).toBeGreaterThanOrEqual(before);
    expect(Number(row.expires_at) - created).toBeCloseTo(120 * MINUTE, -3);
    expect(Number(row.next_escalation_at) - created).toBeCloseTo(30 * MINUTE, -3);
    expect(Number(row.max_expires_at) - created).toBeCloseTo(1_440 * MINUTE, -3);
    expect(edges.recordQuestionAsked).toHaveBeenCalledWith(env, P1, {
      sessionId: 'chat-1',
      askId: filed.id,
      createdAt: filed.createdAt,
      expiresAt: filed.expiresAt,
      reason: 'Which region should the deploy use? EU keeps latency low for our users.',
      options: ['eu', 'us'],
    });
  });

  it('reads the schedule from the admin settings', async () => {
    setting('inbox.questionTimeoutMinutes', '10');
    setting('inbox.questionFirstReminderPercent', '50');
    setting('inbox.questionMaxWaitMinutes', '20');
    const filed = await question({ options: null });
    const row = askRow(filed.id);
    const created = Number(row.created_at);
    expect(Number(row.expires_at) - created).toBe(10 * MINUTE);
    expect(Number(row.next_escalation_at) - created).toBe(5 * MINUTE);
    expect(Number(row.max_expires_at) - created).toBe(20 * MINUTE);
    expect(JSON.parse(String(row.answer_spec_json))).toEqual({ type: 'text' });
  });

  it('applies the per-chat cap from the admin setting', async () => {
    setting('inbox.openItemsPerChat', '1');
    await question();
    await expect(question()).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('refuses a task of another project (the source task must belong to the project)', async () => {
    await expect(question({ taskId: 'task-2' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM asks').get()).toEqual({ n: 0 });
  });

  it('a live-update failure does not lose the filed question', async () => {
    edges.recordQuestionAsked.mockRejectedValue(new Error('DO down'));
    const filed = await question();
    expect(askRow(filed.id).status).toBe('open');
  });
});

describe('answering a question', () => {
  const answer = (askId: string, text: string, projectId = P1, sessionId = 'chat-1') =>
    answerAttention(env, 'owner', projectId, sessionId, askId, text);

  it('accepts an answer: one compare-and-set, the answer delivered as a durable prompt, notified_at recorded', async () => {
    const { id } = await question();
    await expect(answer(id, 'eu')).resolves.toEqual({
      resolved: true,
      alreadyResolved: false,
      answer: 'eu',
    });
    const row = askRow(id);
    expect(row).toMatchObject({ status: 'answered', resolved_by_user_id: 'owner' });
    expect(JSON.parse(String(row.answer_json))).toEqual({ text: 'eu' });
    expect(row.notified_at).not.toBeNull();
    expect(edges.acceptPromptDelivery).toHaveBeenCalledOnce();
    const [, projectId, delivery] = edges.acceptPromptDelivery.mock.calls[0]!;
    expect(projectId).toBe(P1);
    expect(delivery).toMatchObject({
      deliveryId: `inbox-ask:${id}`,
      targetSessionId: 'chat-1',
      sourceTaskId: 'task-1',
      sourceKind: 'inbox_ask',
      metadata: expect.objectContaining({ questionAskId: id, outcome: 'answered' }),
    });
    expect(delivery.deliveryContent).toContain('eu');
    expect(delivery.deliveryContent).toContain('Which region should the deploy use?');
    // A marker-era lookup is never reached for an asks-era question.
    expect(edges.prepareAttentionAnswer).not.toHaveBeenCalled();
  });

  it('keeps today’s outcomes: already answered, conflicting answer, invalid option', async () => {
    const { id } = await question();
    await expect(answer(id, 'mars')).rejects.toMatchObject({ statusCode: 400 });
    expect(askRow(id).status).toBe('open');
    await answer(id, 'eu');
    await expect(answer(id, 'eu')).resolves.toEqual({
      resolved: true,
      alreadyResolved: true,
      answer: 'eu',
    });
    await expect(answer(id, 'us')).rejects.toMatchObject({
      statusCode: 409,
      message: 'Attention request is already resolved',
    });
    expect(edges.acceptPromptDelivery).toHaveBeenCalledOnce();
  });

  it('reports an answer whose delivery was not queued as still being delivered; the sweep delivers it', async () => {
    const { id } = await question();
    edges.acceptPromptDelivery.mockRejectedValueOnce(new Error('DO unavailable'));
    await expect(answer(id, 'eu')).resolves.toEqual({
      resolved: false,
      alreadyResolved: false,
      inFlight: true,
      answer: 'eu',
    });
    expect(askRow(id)).toMatchObject({ status: 'answered', notified_at: null });
    // The same answer again is still in flight; a different one conflicts with it.
    await expect(answer(id, 'eu')).resolves.toMatchObject({ inFlight: true });
    await expect(answer(id, 'us')).rejects.toMatchObject({
      statusCode: 409,
      message: 'A different answer is already being delivered',
    });
    // The sweep retries the notice once it is past the inline grace.
    await runInboxAskSweep(env, Number(askRow(id).resolved_at) + 2 * MINUTE);
    expect(askRow(id).notified_at).not.toBeNull();
    expect(edges.acceptPromptDelivery).toHaveBeenCalledTimes(2);
  });

  it('two people answering at once: exactly one wins, the other gets the conflict', async () => {
    const { id } = await question();
    const results = await Promise.allSettled([answer(id, 'eu'), answer(id, 'us')]);
    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    const winner = (won[0] as PromiseFulfilledResult<{ answer: string }>).value.answer;
    expect(JSON.parse(String(askRow(id).answer_json))).toEqual({ text: winner });
    expect(edges.acceptPromptDelivery).toHaveBeenCalledOnce();
  });

  it('refuses an expired question', async () => {
    const { id } = await question();
    sqlite.prepare('UPDATE asks SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
    await expect(answer(id, 'eu')).rejects.toMatchObject({ statusCode: 409 });
    expect(askRow(id).status).toBe('open');
  });

  it('attack: an ask id addressed through another project or chat is not answered; owner control answers it', async () => {
    const { id } = await question();
    // Foreign project (the caller is a member there) and another chat of the same project.
    insert('project_members', {
      project_id: P2,
      user_id: 'owner',
      role: 'owner',
      status: 'active',
    });
    await expect(answer(id, 'eu', P2, 'chat-2')).rejects.toMatchObject({ statusCode: 404 });
    await expect(answer(id, 'eu', P1, 'chat-other')).rejects.toMatchObject({ statusCode: 404 });
    expect(askRow(id).status).toBe('open');
    expect(edges.acceptPromptDelivery).not.toHaveBeenCalled();
    // Owner control.
    await expect(answer(id, 'eu')).resolves.toMatchObject({ resolved: true });
  });

  it('the inbox answer route goes through the same path and outcomes', async () => {
    const { id } = await question();
    const ctx = {
      env,
      ports: createOperationPorts(env),
      actor: {
        userId: 'owner',
        via: 'web' as const,
        scopes: new Set(['sam.read', 'sam.write'] as const),
      },
      requestId: 't',
    };
    await expect(
      answerInboxItem(ctx, { projectId: P1, ref: `ask:${id}`, answer: 'us' })
    ).resolves.toEqual({ ref: `ask:${id}`, outcome: 'answered', agentNotified: true });
    expect(JSON.parse(String(askRow(id).answer_json))).toEqual({ text: 'us' });
    // A second inbox answer meets the closed row.
    await expect(
      answerInboxItem(ctx, { projectId: P1, ref: `ask:${id}`, answer: 'eu' })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('archiving from the inbox closes it and tells the agent in question words', async () => {
    const { id } = await question();
    const ctx = {
      env,
      ports: createOperationPorts(env),
      actor: {
        userId: 'owner',
        via: 'web' as const,
        scopes: new Set(['sam.read', 'sam.write'] as const),
      },
      requestId: 't',
    };
    await expect(archiveInboxItem(ctx, { projectId: P1, ref: `ask:${id}` })).resolves.toMatchObject(
      { outcome: 'archived', agentNotified: true }
    );
    expect(askRow(id).status).toBe('archived');
    const delivery = edges.acceptPromptDelivery.mock.calls[0]![2];
    expect(delivery.deliveryContent).toContain('archived your question');
    expect(delivery.metadata).toMatchObject({ questionAskId: id, outcome: 'archived' });
    // A late answer from the chat card meets the archived row.
    await expect(answer(id, 'eu')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the chat card read (GET …/attention/:id)', () => {
  function app() {
    const app = new Hono<{ Bindings: Env }>();
    const routes = new Hono<{ Bindings: Env }>();
    registerChatAttentionRoute(routes);
    app.route('/api/projects/:projectId/sessions', routes);
    app.onError((error, c) =>
      c.json({ message: error.message }, 'statusCode' in error ? (error.statusCode as 404) : 500)
    );
    return app;
  }
  const read = (projectId: string, sessionId: string, id: string) =>
    app().request(`/api/projects/${projectId}/sessions/${sessionId}/attention/${id}`, {}, env);

  it('returns the shape a marker read had, answerable by the chat’s writer', async () => {
    const { id, createdAt } = await question();
    const response = await read(P1, 'chat-1', id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request: {
        id,
        reason: 'Which region should the deploy use? EU keeps latency low for our users.',
        options: ['eu', 'us'],
        category: 'decision',
        createdAt,
        resolvedAt: null,
        resolvedAnswer: null,
        expired: false,
        canAnswer: true,
      },
      session: { id: 'chat-1', topic: 'Deploy chat' },
      messages: [],
      since: null,
    });
    await answer(id, 'eu');
    const settled = await (await read(P1, 'chat-1', id)).json();
    expect(settled.request).toMatchObject({ resolvedAnswer: 'eu', canAnswer: false });
    expect(settled.request.resolvedAt).not.toBeNull();
  });

  it('attack: the id read through another project is not found; owner control reads it', async () => {
    const { id } = await question();
    insert('project_members', {
      project_id: P2,
      user_id: 'owner',
      role: 'owner',
      status: 'active',
    });
    edges.getSessionAccess.mockResolvedValue({ session: null, access: { found: false } });
    // Falls through to the marker path, which knows no such marker either.
    vi.spyOn(
      await import('../../../../src/services/project-data'),
      'getAttentionRequest'
    ).mockResolvedValue({
      session: null,
      access: { found: false, role: null, ownerUserId: null, grant: null },
      marker: null,
    } as never);
    expect((await read(P2, 'chat-2', id)).status).toBe(404);
    edges.getSessionAccess.mockResolvedValue({
      session: { topic: 'Deploy chat' },
      access: { found: true, role: 'owner', ownerUserId: 'owner' },
    });
    expect((await read(P1, 'chat-1', id)).status).toBe(200);
  });

  function answer(id: string, text: string) {
    return answerAttention(env, 'owner', P1, 'chat-1', id, text);
  }
});

describe('a typed chat message answers the chat’s open questions', () => {
  it('closes the chat’s open questions only, bound to project and chat, without a notice', async () => {
    const a = await question();
    const b = await question({ context: 'Second question?' });
    const otherChat = await question({ sessionId: 'chat-x', taskId: 'task-x' }).catch(() => null);
    expect(otherChat).toBeNull(); // task-x is not a task of the project
    insert('asks', {
      id: 'foreign',
      project_id: P2,
      assignee_kind: 'user',
      assignee_user_id: 'outsider',
      kind: 'question',
      blocking: 1,
      title: 'Same chat id, other project',
      source_session_id: 'chat-1',
      status: 'open',
      created_at: 1,
      updated_at: 1,
    });
    const broadcast = vi.fn();
    const closed = await closeQuestionAsksForHumanMessage(
      env as never,
      { projectId: P1, sessionId: 'chat-1', messageId: 'msg-1' },
      broadcast
    );
    expect(closed).toBe(2);
    for (const id of [a.id, b.id]) {
      expect(askRow(id)).toMatchObject({ status: 'answered' });
      expect(askRow(id).notified_at).not.toBeNull();
    }
    expect(askRow('foreign').status).toBe('open');
    expect(broadcast).toHaveBeenCalledWith(
      'attention.resolved',
      expect.objectContaining({ sessionId: 'chat-1', markerId: a.id, reason: 'human_message' }),
      'chat-1'
    );
    // The card now reads it as resolved without an answer, as a marker resolved by a message.
    await expect(answerAttention(env, 'owner', P1, 'chat-1', a.id, 'eu')).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('the sweep runs a question’s schedule from asks', () => {
  it('sends each reminder once at its point and then none', async () => {
    const { id } = await question();
    await linkQuestionNotification(env, P1, id, 'notif-1');
    const created = Number(askRow(id).created_at);
    // Before the first point: nothing.
    await runInboxAskSweep(env, created + 29 * MINUTE);
    expect(edges.resendPush).not.toHaveBeenCalled();
    await runInboxAskSweep(env, created + 31 * MINUTE);
    expect(edges.resendPush).toHaveBeenCalledWith(env, 'owner', 'notif-1');
    expect(askRow(id)).toMatchObject({ escalation_count: 1 });
    expect(Number(askRow(id).next_escalation_at) - created).toBeCloseTo(90 * MINUTE, -3);
    // A second tick at the same time does not send it again.
    await runInboxAskSweep(env, created + 32 * MINUTE);
    expect(edges.resendPush).toHaveBeenCalledOnce();
    await runInboxAskSweep(env, created + 91 * MINUTE);
    expect(edges.resendPush).toHaveBeenCalledTimes(2);
    expect(askRow(id)).toMatchObject({ escalation_count: 2, next_escalation_at: null });
  });

  it('extends an undelivered question by the grace, then expires it at the hard limit', async () => {
    const { id } = await question();
    await linkQuestionNotification(env, P1, id, 'notif-1');
    const created = Number(askRow(id).created_at);
    const max = Number(askRow(id).max_expires_at);
    await runInboxAskSweep(env, created + 121 * MINUTE);
    expect(askRow(id).status).toBe('open');
    expect(Number(askRow(id).expires_at)).toBe(created + 121 * MINUTE + 120 * MINUTE);
    expect(askRow(id).next_escalation_at).toBeNull();
    expect(edges.resendPush).toHaveBeenCalledWith(env, 'owner', 'notif-1');
    expect(edges.expireQuestionAsk).not.toHaveBeenCalled();
    // At the hard limit it expires even though no device confirmed the push.
    sqlite.prepare('UPDATE asks SET expires_at = ? WHERE id = ?').run(max, id);
    await runInboxAskSweep(env, max + 1);
    expect(askRow(id).status).toBe('expired');
    expect(edges.expireQuestionAsk).toHaveBeenCalledWith(env, P1, {
      askId: id,
      sessionId: 'chat-1',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      createdAt: created,
    });
    expect(askRow(id).notified_at).not.toBeNull();
    expect(edges.acceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('expires a delivered question at its deadline with today’s task outcome; a failed outcome is retried', async () => {
    const { id } = await question();
    await linkQuestionNotification(env, P1, id, 'notif-1');
    edges.hasConfirmedPushDelivery.mockResolvedValue(true);
    edges.expireQuestionAsk.mockRejectedValueOnce(new Error('DO unavailable'));
    const deadline = Number(askRow(id).expires_at);
    await runInboxAskSweep(env, deadline + 1);
    expect(askRow(id)).toMatchObject({ status: 'expired', notified_at: null });
    await runInboxAskSweep(env, deadline + 2 * MINUTE);
    expect(edges.expireQuestionAsk).toHaveBeenCalledTimes(2);
    expect(askRow(id).notified_at).not.toBeNull();
  });
});
