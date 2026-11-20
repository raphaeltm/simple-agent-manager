/** Real inbox route → operations → sendChat on SQLite; only auth session and DO/VM edges fake. */
import {
  cancelAgentAsk,
  getAgentItem,
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
  getDelivery: vi.fn(),
  deliveries: new Map<string, Record<string, unknown>>(),
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
  getMailboxMessage: edge.getDelivery,
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
function permission() {
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
  return { ref, marker };
}

function pauseSendAuthorization() {
  const authorize = edge.writer.getMockImplementation()!;
  let entered!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  edge.writer.mockImplementation(async (...args) => {
    entered();
    await held;
    return authorize(...args);
  });
  return { paused, release };
}

function replyMessageId(ref: string): string | undefined {
  return (
    sqlite
      .prepare(
        'SELECT message_id FROM inbox_replies WHERE project_id = ? AND item_ref = ? ORDER BY id DESC LIMIT 1'
      )
      .get('p', ref) as { message_id: string } | undefined
  )?.message_id;
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
  edge.deliveries.clear();
  edge.getDelivery.mockImplementation(
    async (_env, _project, id) => edge.deliveries.get(id) ?? null
  );
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
    const existing = edge.deliveries.get(input.deliveryId);
    if (existing) {
      if (
        existing.content !== input.deliveryContent ||
        existing.targetSessionId !== input.targetSessionId ||
        existing.sourceKind !== input.sourceKind
      )
        throw new Error('deliveryId already belongs to a different prompt intent');
      return { message: { id: input.deliveryId }, transcriptMessageId: input.deliveryId };
    }
    edge.deliveries.set(input.deliveryId, {
      id: input.deliveryId,
      content: input.deliveryContent,
      promptMessageId: input.deliveryId,
      sourceKind: input.sourceKind,
      targetSessionId: input.targetSessionId,
      senderType: input.senderType,
      senderId: input.senderId,
      metadata: input.metadata,
      deliveryState: 'queued',
    });
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
  it('an error item reply is recoverable through agent get and respond without changing its status', async () => {
    const ref = ask('error-item');
    sqlite.prepare("UPDATE asks SET kind = 'error' WHERE id = ?").run('error-item');
    expect((await req('/count')).body).toMatchObject({ needsYou: 1 });
    const sent = await req(path(ref, '/reply'), { content: 'Please investigate this failure.' });
    expect(sent.status).toBe(202);
    expect((await req('')).body.items).toHaveLength(0);
    expect((await req('/count')).body.needsYou).toBe(0);
    const context = ctx();
    context.ports.inboxTasks.createComment = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'error-response' } });
    const read = await getAgentItem(context, source, { ref });
    expect(read).toMatchObject({
      kind: 'error',
      withAgent: true,
      pendingReplyIds: [sent.body.messageId],
      conversation: {
        replies: [expect.objectContaining({ content: 'Please investigate this failure.' })],
      },
    });
    const recoveredId = 'pendingReplyIds' in read ? read.pendingReplyIds[0] : undefined;
    await expect(
      respondToAgentInboxItem(context, source, {
        ref,
        replyMessageId: recoveredId,
        body: 'I found the failure and am retrying.',
      })
    ).resolves.toMatchObject({ ref });
    expect(context.ports.inboxTasks.createComment).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ askId: 'error-item', body: 'I found the failure and am retrying.' })
    );
    expect((await req('')).body.items).toEqual([
      expect.objectContaining({ ref, kind: 'error', status: 'open', withAgent: false }),
    ]);
    expect((await req('/count')).body.needsYou).toBe(1);
    expect(sqlite.prepare('SELECT status FROM asks').get()).toEqual({ status: 'open' });
  });
  it.each(['foreign-source', 'closed', 'expired'] as const)(
    'refuses an error response when its source is %s',
    async (change) => {
      const ref = ask('error-item');
      sqlite.prepare("UPDATE asks SET kind = 'error' WHERE id = ?").run('error-item');
      const sent = await req(path(ref, '/reply'), { content: 'Please investigate this failure.' });
      expect(sent.status).toBe(202);
      if (change === 'foreign-source')
        sqlite.prepare("UPDATE asks SET source_session_id = 'other-chat'").run();
      if (change === 'closed') sqlite.prepare("UPDATE asks SET status = 'answered'").run();
      if (change === 'expired')
        sqlite.prepare('UPDATE asks SET expires_at = ?').run(Date.now() - 1);
      const context = ctx();
      context.ports.inboxTasks.createComment = vi.fn();
      await expect(
        respondToAgentInboxItem(context, source, {
          ref,
          replyMessageId: sent.body.messageId,
          body: 'Retrying.',
        })
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(context.ports.inboxTasks.createComment).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT agent_acted_at FROM inbox_replies').get()).toEqual({
        agent_acted_at: null,
      });
    }
  );
  it.each(['update', 'resolve', 'cancel'] as const)(
    'respond eligibility does not authorize agent %s of an error item',
    async (method) => {
      const ref = ask('error-item');
      sqlite.prepare("UPDATE asks SET kind = 'error' WHERE id = ?").run('error-item');
      const sent = await req(path(ref, '/reply'), { content: 'Please investigate this failure.' });
      expect(sent.status).toBe(202);
      const input = { ref, replyMessageId: sent.body.messageId };
      const action =
        method === 'update'
          ? updateAgentAsk(ctx(), source, { ...input, title: 'Changed error' })
          : method === 'resolve'
            ? resolveAgentInboxItem(ctx(), source, input)
            : cancelAgentAsk(ctx(), source, { ref, reason: 'No longer needed' });
      await expect(action).rejects.toThrow();
      expect(sqlite.prepare('SELECT kind, status FROM asks').get()).toEqual({
        kind: 'error',
        status: 'open',
      });
      expect(sqlite.prepare('SELECT agent_acted_at FROM inbox_replies').get()).toEqual({
        agent_acted_at: null,
      });
    }
  );

  it('responds before any human reply without requiring a ledger acknowledgement', async () => {
    const ref = ask();
    const context = ctx();
    context.ports.inboxTasks.createComment = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'first-response' } });
    await expect(
      respondToAgentInboxItem(context, source, { ref, body: 'Additional context.' })
    ).resolves.toMatchObject({ ref });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 0 });
  });
  it.each(['resolvedAt', 'inboxArchivedAt', 'expiresAt', 'unchanged'] as const)(
    'respond rechecks canonical attention %s after the comment await',
    async (change) => {
      const ref = 'attention:chat:question-marker';
      const marker = {
        id: 'question-marker',
        sessionId: 'chat',
        taskId: 'task',
        source: 'agent',
        reason: 'question',
        metadata: null,
        createdAt: 1000,
        expiresAt: null as number | null,
        resolvedAt: null as number | null,
        inboxArchivedAt: null as number | null,
      };
      insert('session_summaries', {
        id: 'chat',
        project_id: 'p',
        created_by_user_id: 'owner',
        updated_at: 1000,
      });
      edge.marker.mockImplementation(async () => ({
        session: { topic: 'Chat' },
        marker,
        canRead: true,
        writer: true,
      }));
      const sent = await req(path(ref, '/reply'), { content: 'Please explain the question.' });
      expect(sent.status).toBe(202);
      const context = ctx();
      context.ports.inboxTasks.createComment = vi.fn().mockImplementation(async () => {
        if (change !== 'unchanged') marker[change] = Date.now() - 1;
        return { thread: { id: 'response' } };
      });
      const response = respondToAgentInboxItem(context, source, {
        ref,
        replyMessageId: sent.body.messageId,
        body: 'Here is the explanation.',
      });
      if (change === 'unchanged') await expect(response).resolves.toMatchObject({ ref });
      else await expect(response).rejects.toMatchObject({ code: 'conflict' });
      const ledger = sqlite.prepare('SELECT agent_acted_at FROM inbox_replies').get() as {
        agent_acted_at: number | null;
      };
      expect(ledger.agent_acted_at === null).toBe(change !== 'unchanged');
      expect(context.ports.inboxTasks.createComment).toHaveBeenCalledOnce();
    }
  );

  it.each([true, false])('cancel refuses outstanding replies: %s', async (pending) => {
    const ref = ask();
    if (pending)
      expect((await req(path(ref, '/reply'), { content: 'Please explain.' })).status).toBe(202);
    const cancellation = cancelAgentAsk(ctx(), source, { ref, reason: 'No longer needed' });
    if (pending) {
      await expect(cancellation).rejects.toMatchObject({ code: 'conflict' });
      expect(sqlite.prepare('SELECT status FROM asks').get()).toEqual({ status: 'open' });
      expect(sqlite.prepare('SELECT agent_acted_at FROM inbox_replies').get()).toEqual({
        agent_acted_at: null,
      });
      expect((await req(path(ref))).body.item).toMatchObject({ withAgent: true });
    } else {
      await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' });
    }
  });
  it('refuses a late reply reservation after cancellation wins during authorization', async () => {
    const ref = ask();
    const { paused, release } = pauseSendAuthorization();
    const reply = req(path(ref, '/reply'), { content: 'Please explain.' });
    await paused;
    try {
      await expect(
        cancelAgentAsk(ctx(), source, { ref, reason: 'No longer needed' })
      ).resolves.toMatchObject({ status: 'cancelled' });
    } finally {
      release();
    }
    expect((await reply).status).toBe(409);
    expect(edge.accept).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 0 });
  });
  it.each(['ask', 'secret', 'approval'] as const)(
    'respond rechecks %s eligibility after persisting the comment',
    async (store) => {
      const id = 'response-race';
      const ref = `${store}:${id}`;
      if (store === 'ask') ask(id);
      else if (store === 'secret')
        insert('runtime_secret_requests', {
          id,
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
      else
        insert('operations_action_approvals', {
          id,
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
      // Each change lands inside the comment-port await, after the initial source read.
      for (const change of ['settled', 'expired', 'other-session', 'unchanged'] as const) {
        const sent = await req(path(ref, '/reply'), { content: `Question before ${change}` });
        expect(sent.status).toBe(202);
        const context = ctx();
        context.ports.inboxTasks.createComment = vi.fn().mockImplementation(async () => {
          const table =
            store === 'ask'
              ? 'asks'
              : store === 'secret'
                ? 'runtime_secret_requests'
                : 'operations_action_approvals';
          if (change === 'settled')
            sqlite
              .prepare(`UPDATE ${table} SET status = ? WHERE id = ?`)
              .run(
                store === 'ask' ? 'answered' : store === 'secret' ? 'fulfilled' : 'approved',
                id
              );
          if (change === 'expired')
            sqlite
              .prepare(`UPDATE ${table} SET expires_at = ? WHERE id = ?`)
              .run(
                store === 'approval' ? new Date(Date.now() - 1).toISOString() : Date.now() - 1,
                id
              );
          if (change === 'other-session') {
            const column =
              store === 'ask'
                ? 'source_session_id'
                : store === 'secret'
                  ? 'requesting_chat_session_id'
                  : 'requesting_session_id';
            sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run('other-chat', id);
          }
          return { thread: { id: `response-${change}` } };
        });
        const response = respondToAgentInboxItem(context, source, {
          ref,
          replyMessageId: sent.body.messageId,
          body: 'I have read this.',
        });
        if (change === 'unchanged') await expect(response).resolves.toMatchObject({ ref });
        else await expect(response).rejects.toMatchObject({ code: 'conflict' });
        expect(context.ports.inboxTasks.createComment).toHaveBeenCalledOnce();
        const ledger = sqlite
          .prepare('SELECT agent_acted_at FROM inbox_replies WHERE message_id = ?')
          .get(sent.body.messageId) as { agent_acted_at: number | null };
        expect(ledger.agent_acted_at === null).toBe(change !== 'unchanged');
        // Restore only fixture source state: failed response acknowledgement remains outstanding.
        if (store === 'ask')
          sqlite
            .prepare(
              "UPDATE asks SET status = 'open', expires_at = NULL, source_session_id = 'chat' WHERE id = ?"
            )
            .run(id);
        else if (store === 'secret')
          sqlite
            .prepare(
              "UPDATE runtime_secret_requests SET status = 'pending', expires_at = ?, requesting_chat_session_id = 'chat' WHERE id = ?"
            )
            .run(Date.now() + 3600000, id);
        else
          sqlite
            .prepare(
              "UPDATE operations_action_approvals SET status = 'pending', expires_at = ?, requesting_session_id = 'chat' WHERE id = ?"
            )
            .run(new Date(Date.now() + 3600000).toISOString(), id);
        expect((await req(path(ref))).body.item).toMatchObject({ withAgent: true });
      }
    }
  );

  it.each(['respond', 'update', 'resolve'] as const)(
    'refuses %s on an expired ask without changing or acknowledging it',
    async (method) => {
      const ref = ask();
      const sent = await req(path(ref, '/reply'), { content: 'Use the smaller limit.' });
      expect(sent.status).toBe(202);
      const context = ctx();
      context.ports.inboxTasks.createComment = vi
        .fn()
        .mockResolvedValue({ thread: { id: 'response' } });
      sqlite.prepare('UPDATE asks SET expires_at = ? WHERE id = ?').run(Date.now() - 1, 'q');
      const input = { ref, replyMessageId: sent.body.messageId };
      const action =
        method === 'respond'
          ? respondToAgentInboxItem(context, source, { ...input, body: 'Understood.' })
          : method === 'update'
            ? updateAgentAsk(context, source, { ...input, title: 'Changed title' })
            : resolveAgentInboxItem(context, source, input);
      await expect(action).rejects.toThrow();
      expect(context.ports.inboxTasks.createComment).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT agent_acted_at FROM inbox_replies').get()).toEqual({
        agent_acted_at: null,
      });
      expect(sqlite.prepare('SELECT status, title FROM asks').get()).toEqual({
        status: 'open',
        title: 'Choose the retry cap?',
      });
      expect((await req('/count')).body.needsYou).toBe(0);
    }
  );
  it('refuses a reply when its ask expires during send authorization', async () => {
    const ref = ask();
    const { paused, release } = pauseSendAuthorization();
    const reply = req(path(ref, '/reply'), { content: 'Use the smaller limit.' });
    await paused;
    try {
      sqlite.prepare('UPDATE asks SET expires_at = ? WHERE id = ?').run(Date.now() - 1, 'q');
    } finally {
      release();
    }
    expect((await reply).status).toBe(409);
    expect(edge.accept).not.toHaveBeenCalled();
    expect(edge.messages).toHaveLength(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 0 });
  });
  it.each(['get', 'respond'] as const)(
    'refuses agent %s on an expired approval without acknowledging its reply',
    async (method) => {
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
      const ref = 'approval:approval';
      const sent = await req(path(ref, '/reply'), { content: 'Why is this necessary?' });
      expect(sent.status).toBe(202);
      const context = ctx();
      context.ports.inboxTasks.createComment = vi
        .fn()
        .mockResolvedValue({ thread: { id: 'response' } });
      await expect(getAgentItem(context, source, { ref })).resolves.toMatchObject({
        ref,
        withAgent: true,
      });
      sqlite
        .prepare('UPDATE operations_action_approvals SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 1).toISOString(), 'approval');
      const action =
        method === 'get'
          ? getAgentItem(context, source, { ref })
          : respondToAgentInboxItem(context, source, {
              ref,
              replyMessageId: sent.body.messageId,
              body: 'Retry the restart.',
            });
      await expect(action).rejects.toMatchObject({ code: 'not_found' });
      expect(context.ports.inboxTasks.createComment).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT agent_acted_at FROM inbox_replies').get()).toEqual({
        agent_acted_at: null,
      });
      expect(sqlite.prepare('SELECT status FROM operations_action_approvals').get()).toEqual({
        status: 'pending',
      });
      expect((await req('/count')).body.needsYou).toBe(0);
    }
  );
  it.each([
    ['secret', 'fulfilled'],
    ['secret', 'expired'],
    ['secret', 'other-session'],
    ['approval', 'approved'],
    ['approval', 'expired'],
    ['approval', 'other-session'],
  ] as const)(
    'refuses a %s reply when its source becomes %s after preflight',
    async (store, change) => {
      if (store === 'secret') {
        insert('runtime_secret_requests', {
          id: 'race',
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
      } else {
        insert('operations_action_approvals', {
          id: 'race',
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
      }
      const { paused, release } = pauseSendAuthorization();
      const reply = req(path(`${store}:race`, '/reply'), { content: 'Please explain this.' });
      await paused;
      try {
        if (store === 'secret') {
          if (change === 'expired')
            sqlite
              .prepare('UPDATE runtime_secret_requests SET expires_at = ? WHERE id = ?')
              .run(Date.now() - 1, 'race');
          else if (change === 'other-session')
            sqlite
              .prepare(
                'UPDATE runtime_secret_requests SET requesting_chat_session_id = ? WHERE id = ?'
              )
              .run('other-chat', 'race');
          else
            sqlite
              .prepare("UPDATE runtime_secret_requests SET status = 'fulfilled' WHERE id = ?")
              .run('race');
        } else if (change === 'expired') {
          sqlite
            .prepare('UPDATE operations_action_approvals SET expires_at = ? WHERE id = ?')
            .run(new Date(Date.now() - 1).toISOString(), 'race');
        } else if (change === 'other-session') {
          sqlite
            .prepare(
              'UPDATE operations_action_approvals SET requesting_session_id = ? WHERE id = ?'
            )
            .run('other-chat', 'race');
        } else {
          sqlite
            .prepare("UPDATE operations_action_approvals SET status = 'approved' WHERE id = ?")
            .run('race');
        }
      } finally {
        release();
      }
      expect((await reply).status).toBe(409);
      expect(edge.accept).not.toHaveBeenCalled();
      expect(edge.messages).toHaveLength(0);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 0 });
    }
  );
  it.each(['respond', 'update', 'resolve'] as const)(
    '%s never acknowledges an earlier reservation whose reply has not reached the agent',
    async (method) => {
      const ref = ask('q', true);
      const authorize = edge.writer.getMockImplementation()!;
      edge.writer.mockImplementation(async (workerEnv, projectId, sessionId, actorUserId) => ({
        ...(await authorize(workerEnv, projectId, sessionId, 'owner')),
        actorUserId,
        role: actorUserId === 'owner' ? 'owner' : 'grantee',
        grantId: actorUserId === 'owner' ? null : 'mate-grant',
      }));
      const accept = edge.accept.getMockImplementation()!;
      let entered!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      edge.accept.mockImplementation(async (...args) => {
        if (args[2].senderId === 'owner') {
          entered();
          await held;
        }
        return accept(...args);
      });
      const earlier = req(path(ref, '/reply'), { content: 'Earlier reserved A' });
      await paused;
      const a = sqlite.prepare('SELECT message_id FROM inbox_replies').get() as {
        message_id: string;
      };
      try {
        const later = await req(path(ref, '/reply'), { content: 'Later accepted B' }, 'mate');
        expect(later.status).toBe(202);
        expect(edge.messages.map((message) => message.id)).toEqual([later.body.messageId]);
        const context = ctx();
        context.ports.inboxTasks.createComment = vi
          .fn()
          .mockResolvedValue({ thread: { id: 'response' } });
        if (method === 'respond') {
          await respondToAgentInboxItem(context, source, {
            ref,
            replyMessageId: later.body.messageId,
            body: 'Responding to B only',
          });
        } else if (method === 'update') {
          await updateAgentAsk(context, source, {
            ref,
            replyMessageId: later.body.messageId,
            why: 'Updating for B only',
          });
        }
        await expect(
          resolveAgentInboxItem(context, source, { ref, replyMessageId: later.body.messageId })
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(sqlite.prepare('SELECT status FROM asks WHERE id = ?').get('q')).toEqual({
          status: 'open',
        });
        expect(
          sqlite
            .prepare('SELECT agent_acted_at FROM inbox_replies WHERE message_id = ?')
            .get(a.message_id)
        ).toEqual({ agent_acted_at: null });
        expect((await req('/count')).body.needsYou).toBe(0);
        expect((await req('?filter=archived')).body.items[0]).toMatchObject({
          ref,
          withAgent: true,
        });
      } finally {
        release();
        expect((await earlier).status).toBe(202);
      }
      const context = ctx();
      context.ports.inboxTasks.createComment = vi
        .fn()
        .mockResolvedValue({ thread: { id: 'response-a' } });
      await respondToAgentInboxItem(context, source, {
        ref,
        replyMessageId: a.message_id,
        body: 'Now I have read A',
      });
      await expect(
        resolveAgentInboxItem(context, source, { ref, replyMessageId: replyMessageId(ref)! })
      ).resolves.toMatchObject({ status: 'answered' });
    }
  );
  it('refuses a reply whose open-item preflight raced the agent resolving the ask', async () => {
    const ref = ask();
    const first = await req(path(ref, '/reply'), { content: 'Reply A' });
    const { paused, release } = pauseSendAuthorization();
    // requireActable already loaded an open ask before chat send authorization pauses.
    const second = req(path(ref, '/reply'), { content: 'Reply B' });
    await paused;
    try {
      await expect(
        resolveAgentInboxItem(ctx(), source, {
          ref,
          replyMessageId: first.body.messageId,
        })
      ).resolves.toMatchObject({ status: 'answered', messageId: first.body.messageId });
    } finally {
      release();
    }
    expect((await second).status).toBe(409);
    expect(edge.accept).toHaveBeenCalledTimes(1);
    expect(edge.messages).toHaveLength(1);
    expect(sqlite.prepare('SELECT message_id FROM inbox_replies').all()).toEqual([
      { message_id: first.body.messageId },
    ]);
    expect(sqlite.prepare('SELECT status FROM asks WHERE id = ?').get('q')).toEqual({
      status: 'answered',
    });
  });
  it.each(['respond', 'update', 'resolve'] as const)(
    '%s requires the observed reply id and refuses another item’s reply',
    async (method) => {
      const ref = ask();
      const foreignRef = ask('foreign-item');
      const first = await req(path(ref, '/reply'), { content: 'Reply to the first item' });
      const foreign = await req(path(foreignRef, '/reply'), { content: 'Reply to another item' });
      const context = ctx();
      context.ports.inboxTasks.createComment = vi
        .fn()
        .mockResolvedValue({ thread: { id: 'response' } });
      const act = (observedId?: string) => {
        const input = { ref, ...(observedId ? { replyMessageId: observedId } : {}) };
        if (method === 'respond')
          return respondToAgentInboxItem(context, source, { ...input, body: 'Response' });
        if (method === 'update')
          return updateAgentAsk(context, source, { ...input, why: 'Updated ask' });
        return resolveAgentInboxItem(context, source, input);
      };
      await expect(act()).rejects.toThrow();
      await expect(act(foreign.body.messageId)).rejects.toThrow();
      expect(context.ports.inboxTasks.createComment).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT status FROM asks WHERE id = ?').get('q')).toEqual({
        status: 'open',
      });
      expect(
        sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies WHERE agent_acted_at IS NULL').get()
      ).toEqual({ n: 2 });
      await expect(act(first.body.messageId)).resolves.toBeDefined();
      expect(
        sqlite
          .prepare('SELECT agent_acted_at FROM inbox_replies WHERE message_id = ?')
          .get(foreign.body.messageId)
      ).toEqual({ agent_acted_at: null });
    }
  );
  it.each(['respond', 'update'] as const)(
    '%s acknowledges only the reply the agent observed when a later reply was already queued',
    async (method) => {
      const ref = ask();
      const first = await req(path(ref, '/reply'), { content: 'Reply A' });
      const second = await req(path(ref, '/reply'), { content: 'Reply B' });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      const context = ctx();
      context.ports.inboxTasks.createComment = vi
        .fn()
        .mockResolvedValue({ thread: { id: 'response' } });
      if (method === 'respond') {
        await respondToAgentInboxItem(context, source, {
          ref,
          replyMessageId: first.body.messageId,
          body: 'Responding to A',
        });
      } else {
        await updateAgentAsk(context, source, {
          ref,
          replyMessageId: first.body.messageId,
          why: 'Updating after A',
        });
      }
      const rows = sqlite
        .prepare('SELECT message_id, agent_acted_at FROM inbox_replies ORDER BY id')
        .all() as { message_id: string; agent_acted_at: number | null }[];
      expect(rows).toEqual([
        { message_id: first.body.messageId, agent_acted_at: expect.any(Number) },
        { message_id: second.body.messageId, agent_acted_at: null },
      ]);
      expect((await req('')).body.items).toHaveLength(0);
      expect((await req('/count')).body).toEqual({ needsYou: 0, blocking: 0 });
      expect((await req('?filter=archived')).body.items[0]).toMatchObject({ ref, withAgent: true });
    }
  );

  it('cannot resolve observed reply A while B is outstanding; responding to A then resolving B closes the ask', async () => {
    const ref = ask();
    const first = await req(path(ref, '/reply'), { content: 'Reply A' });
    const second = await req(path(ref, '/reply'), { content: 'Reply B' });
    await expect(
      resolveAgentInboxItem(ctx(), source, {
        ref,
        replyMessageId: first.body.messageId,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(sqlite.prepare('SELECT status, answer_json FROM asks WHERE id = ?').get('q')).toEqual({
      status: 'open',
      answer_json: null,
    });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies WHERE agent_acted_at IS NULL').get()
    ).toEqual({ n: 2 });
    expect((await req('/count')).body).toEqual({ needsYou: 0, blocking: 0 });
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({ ref, withAgent: true });
    const context = ctx();
    context.ports.inboxTasks.createComment = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'response-a' } });
    await respondToAgentInboxItem(context, source, {
      ref,
      replyMessageId: first.body.messageId,
      body: 'I have read A.',
    });
    await expect(
      resolveAgentInboxItem(ctx(), source, {
        ref,
        replyMessageId: second.body.messageId,
      })
    ).resolves.toMatchObject({ status: 'answered', messageId: second.body.messageId });
    const row = sqlite.prepare('SELECT status, answer_json FROM asks WHERE id = ?').get('q') as {
      status: string;
      answer_json: string;
    };
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answer_json)).toEqual({ messageId: second.body.messageId });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies WHERE agent_acted_at IS NULL').get()
    ).toEqual({ n: 0 });
  });
  it('admits only one overlapping reply from the same ledger epoch and allows later reply epochs', async () => {
    const ref = ask();
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareSpy = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes('SELECT id, message_id, agent_acted_at FROM inbox_replies'))
        return statement;
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, 'bind').mockImplementation((...values) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        vi.spyOn(bound, 'first').mockImplementation(async (column) => {
          // Execute real SQL first, then hold its result: both requests observed no prior row.
          const row = await first(column);
          if (++reads === 2) release();
          await bothRead;
          return row;
        });
        return bound;
      });
      return statement;
    });
    const payload = { content: 'Use the project setting.' };
    const results = await Promise.all([
      req(path(ref, '/reply'), payload),
      req(path(ref, '/reply'), payload),
    ]);
    prepareSpy.mockRestore();
    expect(reads).toBe(2);
    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    expect(edge.accept).toHaveBeenCalledTimes(1);
    expect(edge.messages).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 1 });
    expect((await req('/count')).body.needsYou).toBe(0);
    // A later, different message is a legitimate new reply, even before the agent acts.
    expect(
      (await req(path(ref, '/reply'), { content: 'Also check the user override.' })).status
    ).toBe(202);
    expect(edge.messages).toHaveLength(2);
    const context = ctx();
    context.ports.inboxTasks.createComment = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'response' } });
    await respondToAgentInboxItem(context, source, {
      ref,
      replyMessageId: String(edge.messages[0].id),
      body: 'I checked the project setting.',
    });
    await respondToAgentInboxItem(context, source, {
      ref,
      replyMessageId: replyMessageId(ref),
      body: 'I checked both overrides.',
    });
    expect((await req('/count')).body.needsYou).toBe(1);
    // The same text after an agent response belongs to another epoch and must be delivered.
    expect((await req(path(ref, '/reply'), payload)).status).toBe(202);
    expect(edge.messages).toHaveLength(3);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 3 });
    expect((await req('/count')).body.needsYou).toBe(0);
  });

  it('preserves an in-flight reply reservation when a concurrent retry sees no mailbox receipt yet', async () => {
    const ref = ask();
    const accept = edge.accept.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accepting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let accepts = 0;
    edge.accept.mockImplementation(async (...args) => {
      if (++accepts === 1) {
        entered();
        await held;
      }
      return accept(...args);
    });
    const first = req(path(ref, '/reply'), { content: 'Use the project setting.' });
    await accepting;
    const reservation = sqlite.prepare('SELECT message_id FROM inbox_replies').get();
    try {
      expect(edge.deliveries.size).toBe(0);
      const second = await req(path(ref, '/reply'), { content: 'Use the project setting.' });
      expect(second.status).toBe(202);
      expect(second.body.deliveryId).toBe((reservation as { message_id: string }).message_id);
      expect(sqlite.prepare('SELECT message_id FROM inbox_replies').all()).toEqual([reservation]);
      expect(edge.accept).toHaveBeenCalledTimes(2);
      expect(edge.messages).toHaveLength(1);
    } finally {
      release();
    }
    const accepted = await first;
    expect(accepted.status).toBe(202);
    expect(reservation).toEqual({ message_id: accepted.body.deliveryId });
    expect(edge.messages).toHaveLength(1);
    expect((await req('/count')).body.needsYou).toBe(0);
  });

  it('returns the committed delivery after acceptance finalization throws and deduplicates the person’s retry', async () => {
    const ref = ask();
    const accept = edge.accept.getMockImplementation()!;
    edge.accept.mockImplementation(async (...args) => {
      await accept(...args);
      throw new Error('alarm finalization failed after SQL commit');
    });
    const first = await req(path(ref, '/reply'), { content: 'Use the project setting.' });
    expect(first.status).toBe(202);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 1 });
    expect((await req('/count')).body.needsYou).toBe(0);
    const retry = await req(path(ref, '/reply'), { content: 'Use the project setting.' });
    expect(retry.status).toBe(202);
    expect(retry.body.deliveryId).toBe(first.body.deliveryId);
    expect(edge.accept).toHaveBeenCalledTimes(1);
    expect(edge.messages).toHaveLength(1);
    edge.deliveries.get(first.body.deliveryId)!.senderType = 'agent';
    expect((await req(path(ref, '/reply'), { content: 'Use the project setting.' })).status).toBe(
      409
    );
    expect(edge.accept).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing permission receipt after another answer settles its request', async () => {
    const { ref, marker } = permission();
    edge.accept.mockRejectedValueOnce(new Error('accept disconnected'));
    edge.getDelivery.mockRejectedValueOnce(new Error('lookup unavailable'));
    const payload = { content: 'Please use a safer command.' };
    expect((await req(path(ref, '/reply'), payload)).status).toBe(500);
    marker.resolvedAt = Date.now();
    sqlite.prepare('UPDATE session_summaries SET attention_json = NULL').run();
    expect((await req(path(ref, '/reply'), payload)).status).toBe(409);
    expect(edge.accept).toHaveBeenCalledTimes(1);
    expect(edge.answer).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 1 });
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'a terminal permission resend retains the reject receipt; competing: %s, changed content: %s',
    async (competing, changed) => {
      const { ref } = permission();
      const payload = { content: 'Please use a safer command.' };
      const first = await req(path(ref, '/reply'), payload);
      expect(first.status).toBe(202);
      const guard = edge.deliveries.get(first.body.deliveryId)!.metadata as {
        inboxReplyPermission: unknown;
      };
      edge.deliveries.get(first.body.deliveryId)!.deliveryState = 'failed';
      if (competing) edge.answer.mockRejectedValue(errors.conflict('another decision won'));
      const second = await req(
        path(ref, '/reply'),
        changed ? { content: 'Please use read-only commands instead.' } : payload
      );
      expect(second.status).toBe(202);
      expect(second.body.deliveryId).not.toBe(first.body.deliveryId);
      const delivery = edge.deliveries.get(second.body.deliveryId)!;
      expect(delivery.metadata).toMatchObject({ inboxReplyPermission: guard.inboxReplyPermission });
      const rejection = await rejectInboxReplyPermission(env, {
        projectId: 'p',
        claim: { message: delivery } as unknown as VmPromptDeliveryAdapterInput['claim'],
      });
      if (competing)
        expect(rejection).toMatchObject({ kind: 'failed', reason: 'delivery_conflict' });
      else expect(rejection).toBeNull();
    }
  );
  it.each(['failed', 'expired'])(
    'a resumed receipt becoming %s cannot report queued',
    async (state) => {
      const ref = ask();
      const payload = { content: 'Please use the original reservation.' };
      const accept = edge.accept.getMockImplementation()!;
      edge.accept.mockRejectedValueOnce(new Error('accept disconnected'));
      edge.getDelivery.mockRejectedValueOnce(new Error('lookup unavailable'));
      expect((await req(path(ref, '/reply'), payload)).status).toBe(500);
      const originalId = replyMessageId(ref)!;
      edge.accept.mockImplementationOnce(async (...args) => {
        const accepted = await accept(...args);
        edge.deliveries.get(originalId)!.deliveryState = state;
        return accepted;
      });
      expect((await req(path(ref, '/reply'), payload)).status).toBe(409);
      expect(replyMessageId(ref)).toBe(originalId);
      const explicit = await req(path(ref, '/reply'), payload);
      expect(explicit.status).toBe(202);
      expect(explicit.body.deliveryId).not.toBe(originalId);
    }
  );
  it('the original sender validates the canonical fingerprint before returning queued', async () => {
    const ref = ask();
    const accept = edge.accept.getMockImplementation()!;
    edge.accept.mockImplementationOnce(async (...args) => {
      const accepted = await accept(...args);
      const metadata = edge.deliveries.get(String(accepted.message.id))!.metadata as Record<
        string,
        unknown
      >;
      metadata.inboxReplyFingerprint = 'different winner';
      return accepted;
    });
    expect((await req(path(ref, '/reply'), { content: 'Original content' })).status).toBe(409);
    expect(edge.messages).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 1 });
  });
  it('resumes the same reserved ID after both acceptance and its cleanup lookup fail', async () => {
    const ref = ask();
    edge.accept.mockRejectedValueOnce(new Error('accept RPC disconnected before receipt'));
    edge.getDelivery.mockRejectedValueOnce(new Error('cleanup lookup unavailable'));
    const payload = { content: 'Keep the original reservation.' };
    expect((await req(path(ref, '/reply'), payload)).status).toBe(500);
    const prior = sqlite.prepare('SELECT * FROM inbox_replies').get() as { message_id: string };
    expect(edge.messages).toHaveLength(0);
    const retry = await req(path(ref, '/reply'), payload);
    expect(retry.status).toBe(202);
    expect(retry.body.deliveryId).toBe(prior.message_id);
    expect(sqlite.prepare('SELECT * FROM inbox_replies').all()).toEqual([prior]);
    expect(edge.messages).toHaveLength(1);
  });
  it.each(['answered', 'expired', 'moved', 'acknowledged', 'superseded'] as const)(
    'refuses resuming a missing delivery if its reservation is %s during send preparation',
    async (change) => {
      const ref = ask();
      edge.accept.mockRejectedValueOnce(new Error('no acceptance receipt'));
      edge.getDelivery.mockRejectedValueOnce(new Error('lookup unavailable'));
      const payload = { content: 'Keep the reservation.' };
      expect((await req(path(ref, '/reply'), payload)).status).toBe(500);
      const lookup = edge.getDelivery.getMockImplementation()!;
      edge.getDelivery.mockImplementationOnce(async (...args) => {
        // The retry has read the outstanding ledger and is now checking the canonical receipt.
        if (change === 'answered') sqlite.prepare("UPDATE asks SET status = 'answered'").run();
        if (change === 'expired')
          sqlite.prepare('UPDATE asks SET expires_at = ?').run(Date.now() - 1);
        if (change === 'moved')
          sqlite.prepare("UPDATE asks SET source_session_id = 'other-chat'").run();
        if (change === 'acknowledged')
          sqlite.prepare('UPDATE inbox_replies SET agent_acted_at = ?').run(Date.now());
        if (change === 'superseded')
          sqlite
            .prepare(
              "INSERT INTO inbox_replies (project_id,item_ref,user_id,message_id,replied_at) VALUES ('p',?,'owner','later-id',?)"
            )
            .run(ref, Date.now());
        return lookup(...args);
      });
      expect((await req(path(ref, '/reply'), payload)).status).toBe(409);
      expect(edge.accept).toHaveBeenCalledTimes(1);
      expect(edge.messages).toHaveLength(0);
    }
  );
  it('a different payload losing fixed-ID acceptance returns conflict without replacing the receipt', async () => {
    const ref = ask();
    const accept = edge.accept.getMockImplementation()!;
    edge.accept.mockRejectedValueOnce(new Error('acceptance response lost'));
    edge.getDelivery.mockRejectedValueOnce(new Error('cleanup unavailable'));
    expect((await req(path(ref, '/reply'), { content: 'Original payload' })).status).toBe(500);
    const originalId = replyMessageId(ref)!;
    // Its absence read races the original handler finally committing the old request.
    const lookup = edge.getDelivery.getMockImplementation()!;
    edge.getDelivery.mockImplementationOnce(async () => {
      await accept(...edge.accept.mock.calls[0]!);
      return null;
    });
    expect((await req(path(ref, '/reply'), { content: 'Different retry payload' })).status).toBe(
      409
    );
    edge.getDelivery.mockImplementation(lookup);
    expect(replyMessageId(ref)).toBe(originalId);
    expect(edge.messages).toHaveLength(1);
    expect(edge.messages[0].content).toBe('Original payload');
    expect((await req(path(ref))).body.item.withAgent).toBe(true);
  });
  it('preserves the ledger on an unknown acceptance and reconciles the same delivery on retry', async () => {
    const ref = ask();
    const accept = edge.accept.getMockImplementation()!;
    edge.accept.mockImplementation(async (...args) => {
      await accept(...args);
      throw new Error('connection lost after commit');
    });
    edge.getDelivery.mockRejectedValueOnce(new Error('lookup temporarily unavailable'));
    const first = await req(path(ref, '/reply'), { content: 'Use the project setting.' });
    expect(first.status).toBe(500);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 1 });
    expect((await req('/count')).body.needsYou).toBe(0);
    const retry = await req(path(ref, '/reply'), { content: 'Use the project setting.' });
    expect(retry.status).toBe(202);
    expect(retry.body.deliveryId).toBe(edge.messages[0].id);
    expect(edge.accept).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'expired'])(
    'allows an explicit resend after %s while retaining both replies until an agent responds',
    async (state) => {
      const ref = ask();
      const payload = { content: 'Use the project setting.' };
      const first = await req(path(ref, '/reply'), payload);
      expect(first.status).toBe(202);
      edge.deliveries.get(first.body.deliveryId)!.deliveryState = state;
      // Delivery failure alone never returns an item to the inbox or sends another prompt.
      expect((await req('/count')).body.needsYou).toBe(0);
      expect((await req('?filter=archived')).body.items[0]).toMatchObject({ ref, withAgent: true });
      expect(edge.accept).toHaveBeenCalledTimes(1);
      const resent = await req(path(ref, '/reply'), payload);
      expect(resent.status).toBe(202);
      expect(resent.body.deliveryId).not.toBe(first.body.deliveryId);
      expect(resent.body.messageId).not.toBe(first.body.messageId);
      expect(edge.accept).toHaveBeenCalledTimes(2);
      expect(edge.messages).toHaveLength(2);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_replies').get()).toEqual({ n: 2 });
      expect((await req('/count')).body.needsYou).toBe(0);
      expect((await req('?filter=archived')).body.items[0]).toMatchObject({ ref, withAgent: true });
      const context = ctx();
      context.ports.inboxTasks.createComment = vi
        .fn()
        .mockResolvedValue({ thread: { id: 'response' } });
      await respondToAgentInboxItem(context, source, {
        ref,
        replyMessageId: replyMessageId(ref),
        body: 'I will use the project setting.',
      });
      expect((await req('/count')).body.needsYou).toBe(0);
      await respondToAgentInboxItem(context, source, {
        ref,
        replyMessageId: first.body.messageId,
        body: 'I have checked the original reply too.',
      });
      expect((await req('')).body.items[0]).toMatchObject({ ref, withAgent: false });
      expect((await req('/count')).body.needsYou).toBe(1);
      expect(
        sqlite
          .prepare('SELECT COUNT(*) AS n FROM inbox_replies WHERE agent_acted_at IS NOT NULL')
          .get()
      ).toEqual({ n: 2 });
    }
  );

  it('refuses to re-enqueue an ambiguous delivery and preserves its archived reply', async () => {
    const ref = ask();
    const payload = { content: 'Use the project setting.' };
    const first = await req(path(ref, '/reply'), payload);
    expect(first.status).toBe(202);
    edge.deliveries.get(first.body.deliveryId)!.deliveryState = 'ambiguous';
    expect((await req(path(ref, '/reply'), payload)).status).toBe(409);
    expect(edge.accept).toHaveBeenCalledTimes(1);
    expect(edge.messages).toHaveLength(1);
    expect(sqlite.prepare('SELECT message_id, agent_acted_at FROM inbox_replies').all()).toEqual([
      { message_id: first.body.deliveryId, agent_acted_at: null },
    ]);
    expect((await req('/count')).body.needsYou).toBe(0);
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({ ref, withAgent: true });
  });
  it('hides and counts a reply, returns the canonical transcript without the header, and respond brings it back', async () => {
    const ref = ask();
    expect((await req('/count')).body.needsYou).toBe(1);
    const sent = await req(path(ref, '/reply'), { content: '  Can we do this per project?\n' });
    expect(sent.status).toBe(202);
    const delivery = edge.accept.mock.calls[0]![2];
    expect(delivery).toMatchObject({
      sourceKind: 'inbox_reply',
      // The chat's "Re:" chip reads the title snapshot from the transcript row's metadata.
      metadata: { inboxRef: ref, inboxTitle: 'Choose the retry cap?' },
    });
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
    await respondToAgentInboxItem(context, source, {
      ref,
      replyMessageId: replyMessageId(ref),
      body: 'Yes, per project.',
    });
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
      replyMessageId: replyMessageId('secret:secret'),
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
      resolveAgentInboxItem(
        ctx(),
        { ...source, sessionId: 'foreign' },
        { ref, replyMessageId: replyMessageId(ref) }
      )
    ).rejects.toThrow();
    expect((await req('?filter=archived')).body.items[0].status).toBe('open');
    await expect(
      resolveAgentInboxItem(ctx(), source, { ref, replyMessageId: replyMessageId(ref) })
    ).resolves.toMatchObject({
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
      respondToAgentInboxItem(context, source, {
        ref,
        replyMessageId: replyMessageId(ref),
        body: 'Yes, use the override.',
      })
    ).rejects.toThrow('ack unavailable');
    expect(threads.size).toBe(1);
    expect((await req('/count')).body.needsYou).toBe(0);
    sqlite.exec('DROP TRIGGER fail_ack');
    await expect(
      respondToAgentInboxItem(context, source, {
        ref,
        replyMessageId: replyMessageId(ref),
        body: 'Yes, use the override.',
      })
    ).resolves.toMatchObject({ thread: { id: 'thread-1' } });
    expect(threads.size).toBe(1);
    const calls = vi.mocked(context.ports.inboxTasks.createComment).mock.calls;
    expect(calls[0][1].clientMutationId).toBeTruthy();
    expect(calls[1][1].clientMutationId).toBe(calls[0][1].clientMutationId);
    expect((await req('/count')).body.needsYou).toBe(1);
  });

  it('rolls back an agent update if acknowledging replies fails, then updates and resurfaces atomically', async () => {
    const ref = ask();
    await req(path(ref, '/reply'), { content: 'Can you change the question?' });
    const original = sqlite
      .prepare('SELECT title, body_md, links_json, updated_at FROM asks WHERE id = ?')
      .get('q');
    sqlite.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE OF agent_acted_at ON inbox_replies
      BEGIN SELECT RAISE(ABORT, 'ack unavailable'); END`);
    await expect(
      updateAgentAsk(ctx(), source, {
        ref,
        replyMessageId: replyMessageId(ref),
        title: 'Updated question?',
        why: 'More context',
      })
    ).rejects.toThrow('ack unavailable');
    expect(
      sqlite
        .prepare('SELECT title, body_md, links_json, updated_at FROM asks WHERE id = ?')
        .get('q')
    ).toEqual(original);
    expect(sqlite.prepare('SELECT agent_acted_at FROM inbox_replies').get()).toEqual({
      agent_acted_at: null,
    });
    expect((await req('/count')).body.needsYou).toBe(0);
    expect((await req('?filter=archived')).body.items[0]).toMatchObject({
      title: 'Choose the retry cap?',
      withAgent: true,
    });
    sqlite.exec('DROP TRIGGER fail_ack');
    // Another chat cannot acknowledge the reply through the update batch.
    await expect(
      updateAgentAsk(
        ctx(),
        { ...source, sessionId: 'foreign' },
        { ref, replyMessageId: replyMessageId(ref), why: 'Foreign edit' }
      )
    ).rejects.toThrow();
    expect(sqlite.prepare('SELECT agent_acted_at FROM inbox_replies').get()).toEqual({
      agent_acted_at: null,
    });
    await expect(
      updateAgentAsk(ctx(), source, {
        ref,
        replyMessageId: replyMessageId(ref),
        title: 'Updated question?',
        why: 'More context',
      })
    ).resolves.toMatchObject({ status: 'open' });
    expect((await req('')).body.items[0]).toMatchObject({
      title: 'Updated question?',
      withAgent: false,
    });
    expect((await req('/count')).body.needsYou).toBe(1);
    expect((await req('?filter=archived')).body.items).toHaveLength(0);
  });

  it('rolls back ask resolution if acknowledging its replies fails', async () => {
    const ref = ask();
    await req(path(ref, '/reply'), { content: 'Per project.' });
    sqlite.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE OF agent_acted_at ON inbox_replies
      BEGIN SELECT RAISE(ABORT, 'ack unavailable'); END`);
    await expect(
      resolveAgentInboxItem(ctx(), source, { ref, replyMessageId: replyMessageId(ref) })
    ).rejects.toThrow('ack unavailable');
    expect(sqlite.prepare('SELECT status FROM asks').get()).toEqual({ status: 'open' });
    expect((await req('?filter=archived')).body.items[0].withAgent).toBe(true);
    sqlite.exec('DROP TRIGGER fail_ack');
    await expect(
      resolveAgentInboxItem(ctx(), source, { ref, replyMessageId: replyMessageId(ref) })
    ).resolves.toMatchObject({
      status: 'answered',
    });
    expect((await req('?filter=archived')).body.items[0].withAgent).toBe(false);
  });

  it('a refused delivery retains a recoverable reservation; foreign project, nonwriter and missing-chat requests write nothing', async () => {
    const ref = ask();
    const foreign = await req(path(ref, '/reply'), { content: 'No' }, 'stranger', 'other');
    expect(foreign.status).toBe(404);
    sqlite.prepare("UPDATE asks SET assignee_kind = 'team', assignee_user_id = NULL").run();
    expect((await req(path(ref, '/reply'), { content: 'No' }, 'mate')).status).toBe(403);
    edge.accept.mockRejectedValue(new Error('DO unavailable'));
    expect((await req(path(ref, '/reply'), { content: 'Try this' })).status).toBe(500);
    expect(sqlite.prepare('SELECT count(*) AS n FROM inbox_replies').get()).toEqual({ n: 1 });
    expect((await req('/count')).body.needsYou).toBe(0);
    sqlite.prepare('UPDATE asks SET source_session_id = NULL').run();
    expect((await req(path(ref, '/reply'), { content: 'Hi' })).status).toBe(400);
  });
  it('update brings an ask back, and a newer reply arriving during respond remains with the agent even on the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    const ref = ask();
    await req(path(ref, '/reply'), { content: 'First reply' });
    await updateAgentAsk(ctx(), source, {
      ref,
      replyMessageId: replyMessageId(ref),
      why: 'Updated ask',
    });
    expect((await req('/count')).body.needsYou).toBe(1);
    await req(path(ref, '/reply'), { content: 'Second reply' });
    const context = ctx();
    context.ports.inboxTasks.createComment = vi.fn().mockImplementation(async () => {
      // Same Date.now, but admitted after the agent captured its acknowledged ledger position.
      await req(path(ref, '/reply'), { content: 'Third reply, newer than the response' });
      return { thread: { id: 'thread' }, commentId: 'thread' };
    });
    await respondToAgentInboxItem(context, source, {
      ref,
      replyMessageId: replyMessageId(ref),
      body: 'Answering the second reply',
    });
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
      replyMessageId: replyMessageId('approval:approval'),
      body: 'To recover the worker.',
    });
    expect((await req('/count')).body.needsYou).toBe(1);
    expect(sqlite.prepare('SELECT status FROM operations_action_approvals').get()).toEqual({
      status: 'pending',
    });
  });

  it('rejects a permission before delivery, retains its settled conversation under Archived, and brings a response back without restoring permission buttons', async () => {
    const { ref, marker } = permission();
    // A refused durable acceptance must leave the permission untouched and retryable.
    edge.accept.mockRejectedValueOnce(new Error('ProjectData unavailable'));
    const failed = await req(path(ref, '/reply'), { content: 'Please use a safer command.' });
    expect(failed.status).toBe(500);
    expect(edge.answer).not.toHaveBeenCalled();
    expect(marker.resolvedAt).toBeNull();
    expect((await req('/count')).body).toEqual({ needsYou: 0, blocking: 0 });
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
      replyMessageId: replyMessageId(ref),
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
    const context = ctx();
    context.ports.inboxTasks.createComment = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'response-first' } });
    await respondToAgentInboxItem(context, source, {
      ref,
      replyMessageId: first.body.messageId,
      body: 'I have read the first reply.',
    });
    await expect(
      resolveAgentInboxItem(ctx(), source, { ref, replyMessageId: replyMessageId(ref) })
    ).resolves.toMatchObject({
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
