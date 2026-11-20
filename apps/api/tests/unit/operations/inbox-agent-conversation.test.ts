/** Agent reads recover canonical replies, with real ledger/source authorization on SQLite. */
import { getAgentItem, type OperationContext } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({ messages: vi.fn(), comments: vi.fn(), createComment: vi.fn() }));
vi.mock('../../../src/services/project-data', async (original) => ({
  ...(await original<typeof import('../../../src/services/project-data')>()),
  getSessionAccess: async () => ({ session: { id: 'chat' }, access: { found: true } }),
  getMessages: edge.messages,
  listInboxItemCommentThreads: edge.comments,
  createInboxItemComment: edge.createComment,
  getMailboxMessage: async (_env: unknown, _project: string, id: string) => ({
    id,
    sourceKind: 'inbox_reply',
    targetSessionId: 'chat',
    senderType: 'human',
    metadata: { inboxRef: 'ask:q' },
  }),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import {
  handleInboxGetItem,
  handleInboxRespond,
  handleInboxUpdateItem,
} from '../../../src/routes/mcp/inbox-tools';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let env: Env;
const source = {
  projectId: 'p',
  userId: 'owner',
  sessionId: 'chat',
  taskId: 'task',
  workspaceId: 'ws',
};
const token = { ...source, chatSessionId: 'chat', createdAt: new Date().toISOString() };
function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}
function ctx(): OperationContext {
  return {
    env,
    ports: createOperationPorts(env),
    actor: { userId: 'owner', via: 'workspace-agent', scopes: new Set(['sam.read', 'sam.write']) },
    requestId: 'test',
  };
}
function ask(id: string, session = 'chat') {
  insert('asks', {
    id,
    project_id: 'p',
    source_session_id: session,
    source_task_id: 'task',
    assignee_kind: 'user',
    assignee_user_id: 'owner',
    kind: 'question',
    blocking: 0,
    status: 'open',
    title: 'Which setting?',
    created_at: 1000,
    updated_at: 1000,
  });
}
function reply(id: string, ref = 'ask:q') {
  insert('inbox_replies', {
    project_id: 'p',
    item_ref: ref,
    user_id: 'owner',
    message_id: id,
    replied_at: 2000,
  });
  return {
    id,
    content: `Canonical ${id}`,
    createdAt: 2000,
    sequence: Number(id.slice(-1)) || 1,
    toolMetadata: { source: 'inbox_reply', inboxRef: ref, userId: 'owner' },
  };
}
function payload(response: Awaited<ReturnType<typeof handleInboxGetItem>>) {
  if (!('result' in response)) throw new Error(JSON.stringify(response));
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  insert('users', { id: 'owner', name: 'Owner', email: 'owner@x.test', status: 'active' });
  insert('projects', { id: 'p', user_id: 'owner', name: 'Project' });
  insert('project_members', { project_id: 'p', user_id: 'owner', role: 'owner', status: 'active' });
  insert('tasks', {
    id: 'task',
    project_id: 'p',
    user_id: 'owner',
    chat_session_id: 'chat',
    status: 'in_progress',
  });
  env = { DATABASE: createSqliteD1(sqlite), CHAT_SESSION_MESSAGE_LIMIT: '2' } as unknown as Env;
  edge.comments.mockResolvedValue({ threads: [], hasMore: false });
  edge.messages.mockResolvedValue({ messages: [], hasMore: false });
});
afterEach(() => sqlite.close());

describe('agent inbox conversation recovery', () => {
  it('MCP get exposes never-delivered canonical replies and pending IDs without acknowledging them', async () => {
    ask('q');
    const failed = reply('failed-1');
    const resent = reply('resent-2');
    sqlite
      .prepare('UPDATE inbox_replies SET agent_acted_at = ? WHERE message_id = ?')
      .run(3000, 'resent-2');
    edge.messages.mockResolvedValue({ messages: [failed, resent], hasMore: false });
    const response = payload(await handleInboxGetItem('read', { ref: 'ask:q' }, token, env));
    expect(response.item.conversation.replies).toEqual([
      expect.objectContaining({ id: 'failed-1', content: 'Canonical failed-1' }),
      expect.objectContaining({ id: 'resent-2', content: 'Canonical resent-2' }),
    ]);
    expect(response.item).toMatchObject({ withAgent: true, pendingReplyIds: ['failed-1'] });
    expect(edge.messages).toHaveBeenCalledOnce();
    expect(
      sqlite
        .prepare('SELECT agent_acted_at FROM inbox_replies WHERE message_id = ?')
        .get('failed-1')
    ).toEqual({ agent_acted_at: null });
  });

  it('MCP update reports outstanding replies and directs the agent to read the remaining conversation', async () => {
    ask('q');
    reply('failed-1');
    reply('resent-2');
    const response = payload(
      await handleInboxUpdateItem(
        'update',
        { ref: 'ask:q', why: 'Updated explanation', replyMessageId: 'resent-2' },
        token,
        env
      )
    );
    expect(response.withAgent).toBe(true);
    expect(response.message).toContain('inbox_read get');
    expect(
      sqlite
        .prepare('SELECT agent_acted_at FROM inbox_replies WHERE message_id = ?')
        .get('failed-1')
    ).toEqual({ agent_acted_at: null });
  });

  it('preserves existing other-chat metadata reads without exposing that chat transcript or pending IDs', async () => {
    ask('q', 'other-chat');
    reply('private-1');
    const item = await getAgentItem(ctx(), source, { ref: 'ask:q' });
    expect(item.fromThisChat).toBe(false);
    expect(item).not.toHaveProperty('conversation');
    expect(item).not.toHaveProperty('pendingReplyIds');
    expect(edge.messages).not.toHaveBeenCalled();
  });

  it('replays the same comment receipt if the post-response visibility read fails', async () => {
    ask('q');
    reply('failed-1');
    reply('resent-2');
    const receipts = new Map<string, string>();
    edge.createComment.mockImplementation(async (_env, _project, input) => {
      const prior = receipts.get(input.clientMutationId);
      const id = prior ?? 'response-thread';
      receipts.set(input.clientMutationId, id);
      return { thread: { id }, commentId: id, idempotent: Boolean(prior) };
    });
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    let fail = true;
    const spy = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql) => {
      if (fail && sql.includes('SELECT EXISTS (SELECT 1 FROM inbox_replies')) {
        fail = false;
        throw new Error('visibility unavailable');
      }
      return prepare(sql);
    });
    const input = { ref: 'ask:q', body: 'I checked the resend.', replyMessageId: 'resent-2' };
    expect(await handleInboxRespond('first', input, token, env)).toHaveProperty('error');
    const repeated = payload(await handleInboxRespond('retry', input, token, env));
    spy.mockRestore();
    expect(repeated).toMatchObject({ thread: { id: 'response-thread' }, withAgent: true });
    expect(receipts.size).toBe(1);
    expect(edge.createComment.mock.calls[1]![2].clientMutationId).toBe(
      edge.createComment.mock.calls[0]![2].clientMutationId
    );
  });

  it('rejects foreign-project and invalid refs before reading conversation', async () => {
    ask('q');
    await expect(
      getAgentItem(ctx(), { ...source, projectId: 'foreign' }, { ref: 'ask:q' })
    ).rejects.toThrow();
    await expect(getAgentItem(ctx(), source, { ref: 'invalid' })).rejects.toThrow();
    expect(edge.messages).not.toHaveBeenCalled();
  });

  it('paginates canonical replies and returns only outstanding ids visible on each page', async () => {
    ask('q');
    const first = reply('older-1');
    const second = reply('newer-2');
    edge.messages
      .mockResolvedValueOnce({ messages: [second], hasMore: true })
      .mockResolvedValueOnce({ messages: [first], hasMore: false });
    const page = await getAgentItem(ctx(), source, { ref: 'ask:q' });
    expect(page.pendingReplyIds).toEqual(['newer-2']);
    expect(page.conversation?.nextReplyCursor).toBeTypeOf('string');
    const next = await getAgentItem(ctx(), source, {
      ref: 'ask:q',
      replyCursor: page.conversation!.nextReplyCursor!,
      responseCursor: 0,
    });
    expect(next.pendingReplyIds).toEqual(['older-1']);
    expect(next.conversation?.hasMore).toBe(false);
    expect(edge.messages.mock.calls[1]![4]).toMatchObject({ id: 'newer-2' });
  });

  it.each(['secret', 'approval'] as const)(
    'reads source-owned %s conversation but rejects a different source chat',
    async (store) => {
      const expiresAt = Date.now() + 60000;
      if (store === 'secret')
        insert('runtime_secret_requests', {
          id: 'request',
          project_id: 'p',
          requesting_chat_session_id: 'chat',
          requester_user_id: 'owner',
          env_key: 'KEY',
          reason: 'Access',
          status: 'pending',
          created_at: 1000,
          updated_at: 1000,
          expires_at: expiresAt,
        });
      else
        insert('operations_action_approvals', {
          id: 'request',
          requesting_project_id: 'p',
          requesting_session_id: 'chat',
          requester_user_id: 'owner',
          action: 'test',
          target_type: 'test',
          target_id: 'target',
          reason: 'Approval',
          status: 'pending',
          created_at: new Date().toISOString(),
          expires_at: new Date(expiresAt).toISOString(),
        });
      const ref = `${store}:request`;
      edge.messages.mockResolvedValue({ messages: [reply('reply-1', ref)], hasMore: false });
      expect(await getAgentItem(ctx(), source, { ref })).toMatchObject({
        ref,
        withAgent: true,
        pendingReplyIds: ['reply-1'],
      });
      edge.messages.mockClear();
      await expect(
        getAgentItem(ctx(), { ...source, sessionId: 'foreign' }, { ref })
      ).rejects.toThrow();
      expect(edge.messages).not.toHaveBeenCalled();
    }
  );
});
