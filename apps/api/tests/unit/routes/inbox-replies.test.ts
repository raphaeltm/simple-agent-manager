/** Real inbox route → operations → sendChat on SQLite; only auth session and DO/VM edges fake. */
import {
  type OperationContext,
  resolveAgentInboxItem,
  respondToAgentInboxItem,
  updateAgentAsk,
} from '@simple-agent-manager/operations';
import type {
  InboxCountResponse,
  InboxItemResponse,
  InboxListResponse,
  InboxReplyResponse,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  accept: vi.fn(),
  writer: vi.fn(),
  marker: vi.fn(),
  reject: vi.fn(),
  answer: vi.fn(),
  comments: vi.fn(),
  messages: [] as Record<string, unknown>[],
  ids: [] as string[],
}));
vi.mock('@simple-agent-manager/worker-core', async (original) => {
  const actual = await original<typeof import('@simple-agent-manager/worker-core')>();
  return { ...actual, ulid: () => edge.ids.shift() ?? actual.ulid() };
});
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: (c: { req: { header: (key: string) => string } }) => c.req.header('x-user') || 'owner',
  assertNotAgentSignInSession: vi.fn(),
}));
vi.mock('../../../src/services/session-access', async (original) => ({
  ...(await original<typeof import('../../../src/services/session-access')>()),
  requireSessionWriter: edge.writer,
}));
vi.mock('../../../src/services/session-snapshots', async (original) => ({
  ...(await original<typeof import('../../../src/services/session-snapshots')>()),
  cancelScheduledSessionSleep: vi.fn(),
}));
vi.mock('../../../src/services/mention-enrichment', () => ({
  enrichMessageWithMentions: async (content: string) => ({ enrichedMessage: content }),
}));
vi.mock('../../../src/services/project-data', async (original) => ({
  ...(await original<typeof import('../../../src/services/project-data')>()),
  acceptPromptDelivery: edge.accept,
  getMessages: async () => ({ messages: [...edge.messages], hasMore: false }),
  getSessionAccess: async () => ({ session: { id: 'chat' }, access: { found: true } }),
  listInboxItemCommentThreads: edge.comments,
}));

vi.mock('../../../src/routes/chat-attention', async (original) => ({
  ...(await original<typeof import('../../../src/routes/chat-attention')>()),
  loadAttentionForViewer: edge.marker,
}));
vi.mock('../../../src/services/connector-agent-answer', async (original) => ({
  ...(await original<typeof import('../../../src/services/connector-agent-answer')>()),
  connectorPendingInteractions: edge.reject,
  prepareConnectorAgentAnswer: async (
    _env: unknown,
    _project: string,
    _session: string,
    _id: string,
    choice: { optionId: string }
  ) => ({
    answerKey: 'key',
    decision: { kind: 'selected_option', optionId: choice.optionId, answerHash: 'a'.repeat(64) },
  }),
}));
vi.mock('../../../src/routes/chat-acp-interactions', async (original) => ({
  ...(await original<typeof import('../../../src/routes/chat-acp-interactions')>()),
  answerAgentInteraction: edge.answer,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { errors } from '../../../src/middleware/error';
import { createOperationPorts } from '../../../src/operation-ports';
import { projectInboxRoutes } from '../../../src/routes/inbox';
import { rejectInboxReplyPermission } from '../../../src/services/inbox/reject-reply-permission';
import type { VmPromptDeliveryAdapterInput } from '../../../src/services/vm-prompt-delivery-adapter';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let env: Env;
const origin = 'https://app.example.test';
const app = new Hono<{ Bindings: Env }>()
  .onError(handleAppError)
  .route('/api/projects/:projectId/inbox', projectInboxRoutes);
const source = {
  projectId: 'p',
  sessionId: 'chat',
  taskId: 'task',
  workspaceId: 'ws',
  userId: 'owner',
};
function ctx(): OperationContext {
  return {
    env,
    ports: createOperationPorts(env),
    actor: { userId: 'owner', via: 'workspace-agent', scopes: new Set(['sam.read', 'sam.write']) },
    requestId: 'test',
  };
}
function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}
function ask(id = 'q', team = false) {
  insert('asks', {
    id,
    project_id: 'p',
    source_session_id: 'chat',
    source_task_id: 'task',
    assignee_kind: team ? 'team' : 'user',
    assignee_user_id: team ? null : 'owner',
    kind: 'question',
    blocking: 1,
    status: 'open',
    title: 'Choose the retry cap?',
    created_at: 1000,
    updated_at: 1000,
  });
  return `ask:${id}`;
}
async function req(suffix: string, body?: unknown, user = 'owner', project = 'p') {
  const res = await app.request(
    `https://api.example.test/api/projects/${project}/inbox${suffix}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-user': user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
  return {
    status: res.status,
    body: (await res.json()) as InboxItemResponse &
      InboxListResponse &
      InboxCountResponse &
      InboxReplyResponse,
  };
}
const path = (ref: string, action = '') => `/items/${encodeURIComponent(ref)}${action}`;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec('DROP TABLE inbox_replies');
  applySqliteMigration(
    sqlite,
    new URL('../../../src/db/migrations/0263_inbox_replies.sql', import.meta.url)
  );
  for (const id of ['owner', 'mate', 'stranger'])
    insert('users', { id, name: id, email: `${id}@x.test`, role: 'superadmin', status: 'active' });
  insert('projects', { id: 'p', user_id: 'owner', name: 'Project' });
  insert('projects', { id: 'other', user_id: 'stranger', name: 'Other' });
  for (const id of ['owner', 'mate'])
    insert('project_members', { project_id: 'p', user_id: id, role: 'owner', status: 'active' });
  insert('project_members', {
    project_id: 'other',
    user_id: 'stranger',
    role: 'owner',
    status: 'active',
  });
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
  } as unknown as Env;
  edge.messages = [];
  edge.ids = [];
  edge.comments.mockResolvedValue({ threads: [], hasMore: false });
  edge.writer.mockImplementation(async (_env, projectId, sessionId, actorUserId) => {
    if (actorUserId !== 'owner') throw errors.forbidden('not a session writer');
    return {
      projectId,
      sessionId,
      actorUserId,
      ownerUserId: 'owner',
      role: 'owner',
      session: { id: 'chat' },
      grantId: null,
    };
  });
  edge.accept.mockImplementation(async (_env, _projectId, input) => {
    edge.messages.push({
      id: input.deliveryId,
      role: 'user',
      content: input.displayContent,
      createdAt: Date.now(),
      sequence: 1,
      toolMetadata: { ...input.metadata, source: input.sourceKind },
    });
    return { message: { id: input.deliveryId }, transcriptMessageId: input.deliveryId };
  });
});
afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

describe('inbox replies through the real route on SQLite', () => {
  it('hides and counts a reply, returns the canonical transcript without the header, and respond brings it back', async () => {
    const ref = ask();
    expect((await req('/count')).body.needsYou).toBe(1);
    const sent = await req(path(ref, '/reply'), { content: '  Can we do this per project?\n' });
    expect(sent.status).toBe(202);
    const delivery = edge.accept.mock.calls[0]![2];
    expect(delivery).toMatchObject({ sourceKind: 'inbox_reply', metadata: { inboxRef: ref } });
    expect(delivery.displayContent).toBe('  Can we do this per project?\n');
    expect(delivery.deliveryContent).toContain('Choose the retry cap?');
    expect(delivery.deliveryContent).toContain('inbox_write resolve');
    expect((await req('')).body.items).toHaveLength(0);
    expect((await req('/count')).body).toEqual({ needsYou: 0, blocking: 0 });
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({
      ref,
      status: 'open',
      withAgent: true,
      latestReply: { name: 'owner', messageId: sent.body.messageId },
    });
    const detail = await req(path(ref));
    expect(detail.body.conversation?.replies[0]).toMatchObject({
      id: sent.body.messageId,
      content: delivery.displayContent,
    });
    const context = ctx();
    context.ports.inboxTasks.createComment = vi.fn().mockResolvedValue({
      thread: { id: 'thread', body: 'Yes, per project.' },
      commentId: 'thread',
      idempotent: false,
    });
    await respondToAgentInboxItem(context, source, { ref, body: 'Yes, per project.' });
    expect(context.ports.inboxTasks.createComment).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ askId: 'q', body: 'Yes, per project.' })
    );
    expect((await req('')).body.items).toHaveLength(1);
    expect((await req('/count')).body).toEqual({ needsYou: 1, blocking: 1 });
    expect((await req('?filter=archived')).body.items).toHaveLength(0);
  });

  it('a team reply leaves everyone’s needs-you and blocking list/count', async () => {
    const ref = ask('team', true);
    expect((await req('/count', undefined, 'mate')).body.needsYou).toBe(1);
    expect((await req(path(ref, '/reply'), { content: 'I will check.' })).status).toBe(202);
    for (const user of ['owner', 'mate']) {
      expect((await req('', undefined, user)).body.items).toHaveLength(0);
      expect((await req('?filter=blocking', undefined, user)).body.items).toHaveLength(0);
      expect((await req('/count', undefined, user)).body.needsYou).toBe(0);
      expect((await req('?filter=archived', undefined, user)).body.items[0].latestReply.name).toBe(
        'owner'
      );
    }
  });

  it('keeps a secret pending and responds without resolving it; Archive still declines it', async () => {
    insert('runtime_secret_requests', {
      id: 'secret',
      project_id: 'p',
      env_key: 'KEY',
      reason: 'Need access',
      requester_user_id: 'owner',
      requesting_chat_session_id: 'chat',
      status: 'pending',
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 3600000,
    });
    expect(
      (await req(path('secret:secret', '/reply'), { content: 'Where do I get it?' })).status
    ).toBe(202);
    expect(sqlite.prepare('SELECT status FROM runtime_secret_requests').get()).toEqual({
      status: 'pending',
    });
    expect((await req('/count')).body.needsYou).toBe(0);
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({
      ref: 'secret:secret',
      withAgent: true,
    });
    const context = ctx();
    context.ports.inboxTasks.createComment = vi.fn().mockResolvedValue({ thread: { id: 't' } });
    await respondToAgentInboxItem(context, source, {
      ref: 'secret:secret',
      body: 'In your provider settings.',
    });
    expect((await req('/count')).body.needsYou).toBe(1);
    expect((await req(path('secret:secret', '/archive'), {})).status).toBe(200);
    expect(sqlite.prepare('SELECT status FROM runtime_secret_requests').get()).toEqual({
      status: 'declined',
    });
  });

  it('resolve references the latest chat reply, closes only the calling chat’s ask and sends no notice', async () => {
    const ref = ask();
    const sent = await req(path(ref, '/reply'), { content: 'Per project.' });
    await expect(
      resolveAgentInboxItem(ctx(), { ...source, sessionId: 'foreign' }, { ref })
    ).rejects.toThrow();
    expect((await req('?filter=archived')).body.items[0].status).toBe('open');
    await expect(resolveAgentInboxItem(ctx(), source, { ref })).resolves.toMatchObject({
      status: 'answered',
      messageId: sent.body.messageId,
    });
    const row = sqlite.prepare('SELECT status, answer_json, notified_at FROM asks').get() as {
      status: string;
      answer_json: string;
      notified_at: number;
    };
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answer_json)).toEqual({ messageId: sent.body.messageId });
    expect(row.notified_at).toBeGreaterThan(0);
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({
      status: 'answered',
      withAgent: false,
    });
    expect((await req(path(ref))).body.item.withAgent).toBe(false);
    expect(edge.accept).toHaveBeenCalledTimes(1);
    await expect(resolveAgentInboxItem(ctx(), source, { ref: 'secret:secret' })).rejects.toThrow();
  });

  it('reuses the anchored response receipt when acknowledgement fails, then repairs visibility on retry', async () => {
    const ref = ask();
    await req(path(ref, '/reply'), { content: 'What about a project override?' });
    const context = ctx();
    const threads = new Map<string, string>();
    context.ports.inboxTasks.createComment = vi.fn().mockImplementation(async (_project, input) => {
      const existing = threads.get(input.clientMutationId);
      const id = existing ?? `thread-${threads.size + 1}`;
      threads.set(input.clientMutationId, id);
      return { thread: { id }, commentId: id, idempotent: Boolean(existing) };
    });
    sqlite.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE OF agent_acted_at ON inbox_replies
      BEGIN SELECT RAISE(ABORT, 'ack unavailable'); END`);
    await expect(
      respondToAgentInboxItem(context, source, { ref, body: 'Yes, use the override.' })
    ).rejects.toThrow('ack unavailable');
    expect(threads.size).toBe(1);
    expect((await req('/count')).body.needsYou).toBe(0);
    sqlite.exec('DROP TRIGGER fail_ack');
    await expect(
      respondToAgentInboxItem(context, source, { ref, body: 'Yes, use the override.' })
    ).resolves.toMatchObject({ thread: { id: 'thread-1' } });
    expect(threads.size).toBe(1);
    const calls = vi.mocked(context.ports.inboxTasks.createComment).mock.calls;
    expect(calls[0][1].clientMutationId).toBeTruthy();
    expect(calls[1][1].clientMutationId).toBe(calls[0][1].clientMutationId);
    expect((await req('/count')).body.needsYou).toBe(1);
  });

  it('rolls back ask resolution if acknowledging its replies fails', async () => {
    const ref = ask();
    await req(path(ref, '/reply'), { content: 'Per project.' });
    sqlite.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE OF agent_acted_at ON inbox_replies
      BEGIN SELECT RAISE(ABORT, 'ack unavailable'); END`);
    await expect(resolveAgentInboxItem(ctx(), source, { ref })).rejects.toThrow('ack unavailable');
    expect(sqlite.prepare('SELECT status FROM asks').get()).toEqual({ status: 'open' });
    expect((await req('?filter=archived')).body.items[0].withAgent).toBe(true);
    sqlite.exec('DROP TRIGGER fail_ack');
    await expect(resolveAgentInboxItem(ctx(), source, { ref })).resolves.toMatchObject({
      status: 'answered',
    });
    expect((await req('?filter=archived')).body.items[0].withAgent).toBe(false);
  });

  it('a refused delivery restores the item; foreign project, nonwriter and missing-chat requests write nothing', async () => {
    const ref = ask();
    const foreign = await req(path(ref, '/reply'), { content: 'No' }, 'stranger', 'other');
    expect(foreign.status).toBe(404);
    sqlite.prepare("UPDATE asks SET assignee_kind = 'team', assignee_user_id = NULL").run();
    expect((await req(path(ref, '/reply'), { content: 'No' }, 'mate')).status).toBe(403);
    edge.accept.mockRejectedValue(new Error('DO unavailable'));
    expect((await req(path(ref, '/reply'), { content: 'Try this' })).status).toBe(500);
    expect(sqlite.prepare('SELECT count(*) AS n FROM inbox_replies').get()).toEqual({ n: 0 });
    expect((await req('/count')).body.needsYou).toBe(1);
    sqlite.prepare('UPDATE asks SET source_session_id = NULL').run();
    expect((await req(path(ref, '/reply'), { content: 'Hi' })).status).toBe(400);
  });
  it('update brings an ask back, and a newer reply arriving during respond remains with the agent even on the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    const ref = ask();
    await req(path(ref, '/reply'), { content: 'First reply' });
    await updateAgentAsk(ctx(), source, { ref, why: 'Updated ask' });
    expect((await req('/count')).body.needsYou).toBe(1);
    await req(path(ref, '/reply'), { content: 'Second reply' });
    const context = ctx();
    context.ports.inboxTasks.createComment = vi.fn().mockImplementation(async () => {
      // Same Date.now, but admitted after the agent captured its acknowledged ledger position.
      await req(path(ref, '/reply'), { content: 'Third reply, newer than the response' });
      return { thread: { id: 'thread' }, commentId: 'thread' };
    });
    await respondToAgentInboxItem(context, source, { ref, body: 'Answering the second reply' });
    expect((await req('/count')).body.needsYou).toBe(0);
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({ ref, withAgent: true });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies WHERE agent_acted_at IS NULL').get()
    ).toEqual({ n: 1 });
  });

  it('an approval stays pending, hides from list/count, and an agent response returns it without granting approval', async () => {
    insert('operations_action_approvals', {
      id: 'approval',
      requesting_project_id: 'p',
      requesting_session_id: 'chat',
      requesting_task_id: 'task',
      action: 'restart',
      target_type: 'node',
      target_id: 'node',
      reason: 'Need restart',
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(
      (await req(path('approval:approval', '/reply'), { content: 'Why is this needed?' })).status
    ).toBe(202);
    expect((await req('/count')).body.needsYou).toBe(0);
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({
      ref: 'approval:approval',
      withAgent: true,
    });
    const context = ctx();
    context.ports.inboxTasks.createComment = vi.fn().mockResolvedValue({ thread: { id: 't' } });
    await respondToAgentInboxItem(context, source, {
      ref: 'approval:approval',
      body: 'To recover the worker.',
    });
    expect((await req('/count')).body.needsYou).toBe(1);
    expect(sqlite.prepare('SELECT status FROM operations_action_approvals').get()).toEqual({
      status: 'pending',
    });
  });

  it('rejects a permission before delivery, retains its settled conversation under Archived, and brings a response back without restoring permission buttons', async () => {
    const ref = 'attention:chat:marker';
    const marker = {
      id: 'marker',
      sessionId: 'chat',
      taskId: 'task',
      source: 'acp_interaction',
      reason: 'acp_interaction_pending',
      metadata: JSON.stringify({
        source: 'acp_interaction',
        interactionId: '11111111-1111-4111-8111-111111111111',
        kind: 'permission',
      }),
      createdAt: 1000,
      expiresAt: null,
      resolvedAt: null as number | null,
      inboxArchivedAt: null,
    };
    insert('session_summaries', {
      id: 'chat',
      project_id: 'p',
      created_by_user_id: 'owner',
      updated_at: 1000,
      attention_json: JSON.stringify({
        markerId: 'marker',
        kind: 'needs_input',
        createdAt: 1000,
        expiresAt: null,
        source: 'acp_interaction',
        reason: 'acp_interaction_pending',
        interactionId: '11111111-1111-4111-8111-111111111111',
        interactionKind: 'permission',
      }),
    });
    edge.marker.mockImplementation(async () => ({
      session: { topic: 'Chat' },
      marker,
      canRead: true,
      writer: true,
    }));
    edge.reject.mockResolvedValue([
      {
        interactionId: '11111111-1111-4111-8111-111111111111',
        answerOptions: [
          { id: 'allow', kind: 'allow_once' },
          { id: 'reject-specific', kind: 'reject_once' },
        ],
      },
    ]);
    edge.answer.mockImplementation(async (_env, _user, _project, _chat, _interaction, answer) => {
      expect(answer.decision).toMatchObject({
        kind: 'selected_option',
        optionId: 'reject-specific',
      });
      marker.resolvedAt = Date.now();
      sqlite.prepare('UPDATE session_summaries SET attention_json = NULL').run();
    });
    // A refused durable acceptance must leave the permission untouched and retryable.
    edge.accept.mockRejectedValueOnce(new Error('ProjectData unavailable'));
    const failed = await req(path(ref, '/reply'), { content: 'Please use a safer command.' });
    expect(failed.status).toBe(500);
    expect(edge.answer).not.toHaveBeenCalled();
    expect(marker.resolvedAt).toBeNull();
    expect((await req('/count')).body).toEqual({ needsYou: 1, blocking: 1 });
    // Acceptance succeeds but the immediate rejection fails; its durable metadata
    // lets the delivery adapter repair the rejection before forwarding the message.
    edge.answer.mockRejectedValueOnce(new Error('InteractionStore unavailable'));
    const sent = await req(path(ref, '/reply'), { content: 'Please use a safer command.' });
    expect(sent.status).toBe(202);
    expect(edge.accept.mock.invocationCallOrder[1]).toBeLessThan(
      edge.answer.mock.invocationCallOrder[0]
    );
    expect(edge.accept.mock.calls[1]![2].metadata.inboxReplyPermission).toMatchObject({
      interactionId: '11111111-1111-4111-8111-111111111111',
      answer: { decision: { optionId: 'reject-specific' } },
    });
    expect(marker.resolvedAt).toBeNull();
    const queued = edge.accept.mock.calls[1]![2];
    expect(
      await rejectInboxReplyPermission(env, {
        projectId: 'p',
        claim: { message: queued } as VmPromptDeliveryAdapterInput['claim'],
      })
    ).toBeNull();
    expect(edge.answer.mock.calls[1]![5]).toEqual(edge.answer.mock.calls[0]![5]);
    expect((await req('/count')).body).toEqual({ needsYou: 0, blocking: 0 });
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({
      ref,
      status: 'done',
      withAgent: true,
      canAct: false,
      canReply: true,
    });
    const context = ctx();
    context.ports.inboxTasks.createComment = vi.fn().mockResolvedValue({ thread: { id: 't' } });
    await respondToAgentInboxItem(context, source, {
      ref,
      body: 'I will use a read-only command.',
    });
    expect((await req('/count')).body).toEqual({ needsYou: 1, blocking: 0 });
    expect((await req('')).body.items[0]).toMatchObject({
      ref,
      status: 'done',
      withAgent: false,
      canAct: false,
      canReply: true,
    });
    // Valid but unrelated/malformed current summary must not hide historical permission.
    sqlite.prepare("UPDATE session_summaries SET attention_json = '{}' ").run();
    expect((await req('')).body.items.find((item) => item.ref === ref)).toMatchObject({
      canReply: true,
    });
    const second = await req(path(ref, '/reply'), { content: 'Thanks, carry on.' });
    expect(second.status).toBe(202);
    expect(edge.answer).toHaveBeenCalledTimes(2);
    expect((await req('/count')).body.needsYou).toBe(0);
    const sql = (
      await import('@simple-agent-manager/operations/internal/inbox-list-core')
    ).inboxItemsSql(ctx(), {
      projectId: 'p',
      filter: 'needs_you',
      now: Date.now(),
      forCount: true,
    });
    const plans = sqlite
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM (' + sql.sql + ')')
      .all(...sql.params) as { detail: string }[];
    expect(
      plans.some(
        (plan) =>
          plan.detail.includes('idx_inbox_replies_permissions') &&
          plan.detail.includes('project_id=?')
      )
    ).toBe(true);
  });
  it('latest reply and resolution follow ledger insertion order even when timestamps tie and ULIDs sort in reverse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    const ref = ask();
    edge.ids = ['0000000000000000000000000Z', '0000000000000000000000000A'];
    const first = await req(path(ref, '/reply'), { content: 'First' });
    const second = await req(path(ref, '/reply'), { content: 'Second' });
    expect(first.body.messageId > second.body.messageId).toBe(true);
    expect((await req('?filter=archived')).body.items[0].latestReply?.messageId).toBe(
      second.body.messageId
    );
    expect((await req(path(ref))).body.item.latestReply?.messageId).toBe(second.body.messageId);
    await expect(resolveAgentInboxItem(ctx(), source, { ref })).resolves.toMatchObject({
      messageId: second.body.messageId,
    });
  });

  it('uses the chat’s upload ownership validation, keeps attachments in both copies, and rejects missing uploads before accepting', async () => {
    const ref = ask();
    const attachment = {
      uploadId: '01M7W000000000000000000000',
      filename: 'retry.txt',
      size: 5,
      contentType: 'text/plain',
    };
    const head = vi.fn().mockResolvedValue({ size: 5 });
    env.R2 = { head } as unknown as Env['R2'];
    const sent = await req(path(ref, '/reply'), {
      content: 'See this file.',
      attachments: [attachment],
    });
    expect(sent.status).toBe(202);
    expect(head).toHaveBeenCalledWith(`temp-uploads/owner/${attachment.uploadId}/retry.txt`);
    const delivery = edge.accept.mock.calls[0]![2];
    expect(delivery.metadata.attachments).toEqual([attachment]);
    expect(delivery.displayContent).toContain('See this file.');
    expect(delivery.displayContent).toContain('retry.txt');
    expect(delivery.displayContent).not.toContain('inbox_write');
    expect(delivery.deliveryContent).toContain('retry.txt');
    head.mockResolvedValue(null);
    expect(
      (await req(path(ref, '/reply'), { content: 'Wrong upload', attachments: [attachment] }))
        .status
    ).toBe(400);
    expect(edge.accept).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 1 });
  });
});
