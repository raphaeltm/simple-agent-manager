/** Real browser routes → operations → D1 / ProjectData, plus the real MCP agent tools. */
import type {
  InboxCountResponse,
  InboxItemResponse,
  InboxListResponse,
} from '@simple-agent-manager/shared';
import { DEFAULT_COMMENT_LIST_LIMIT_DEFAULT } from '@simple-agent-manager/shared';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { getCredentialEncryptionKey } from '../../src/lib/secrets';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { registerChatPromptRoute } from '../../src/routes/chat-prompt-route';
import { acpInteractionCallbackRoute } from '../../src/routes/projects/acp-interaction-callback';
import { decrypt } from '../../src/services/encryption';
import { rejectInboxReplyPermission } from '../../src/services/inbox/reject-reply-permission';
import { signCallbackToken } from '../../src/services/jwt';
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

async function ask(s: Seeded, title: string) {
  const filed = await callTool(s.token, 'inbox_write', { method: 'ask', title });
  return filed.inboxItem as { id: string; ref: string };
}

function itemPath(s: Seeded, ref: string) {
  return `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(ref)}`;
}

async function expectInbox(s: Seeded, refs: string[], blocking: number) {
  const list = await get<InboxListResponse>(`/api/projects/${s.projectId}/inbox`, s.ownerCookie);
  expect(list.status).toBe(200);
  expect(list.body.items.map((item) => item.ref).sort()).toEqual([...refs].sort());
  const count = await get<InboxCountResponse>(
    `/api/projects/${s.projectId}/inbox/count`,
    s.ownerCookie
  );
  expect(count.status).toBe(200);
  expect(count.body).toMatchObject({ needsYou: refs.length, blocking });
}

describe('inbox reply capability through real routes and Durable Objects', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    delete testEnv.ACP_INTERACTIONS_ENABLED;
    vi.unstubAllGlobals();
  });

  it('a permission reply persists its rejection and replays it from ProjectData without a self-RPC deadlock', async () => {
    testEnv.ACP_INTERACTIONS_ENABLED = 'true';
    const s = await seed();
    const interactionId = crypto.randomUUID();
    const callbackToken = await signCallbackToken(s.workspaceId, testEnv, {
      callbackGeneration: null,
    });
    const callbacks = new Hono<{ Bindings: Env }>();
    callbacks.onError(handleAppError);
    callbacks.route('/api/projects', acpInteractionCallbackRoute);
    const created = await callbacks.request(
      `/api/projects/${s.projectId}/workspaces/${s.workspaceId}/acp-interactions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${callbackToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          interactionId,
          generation: crypto.randomUUID(),
          runtimeIdentity: 'inbox-reply-runtime',
          agentSessionId: s.agentSessionId,
          kind: 'permission',
          payloadHash: 'a'.repeat(64),
          detail: {
            permissionName: 'Deploy release',
            options: [
              { id: 'yes-specific', kind: 'allow_once', name: 'Allow once' },
              { id: 'no-specific', kind: 'reject_once', name: 'Decline once' },
            ],
          },
          safeSummary: { toolCallId: 'deploy-tool', optionCount: 2 },
          deadlineAt: Date.now() + 60_000,
        }),
      },
      testEnv
    );
    expect(created.status).toBe(201);
    const store = testEnv.INTERACTION_STORE.get(
      testEnv.INTERACTION_STORE.idFromName(`${s.projectId}/${s.chatSessionId}`)
    );
    for (let i = 0; i < 3; i += 1) await runDurableObjectAlarm(store);
    const markerId = await runInDurableObject(
      store,
      async (_instance, state) =>
        state.storage.sql
          .exec(
            'SELECT attention_marker_id FROM interactions WHERE interaction_id = ?',
            interactionId
          )
          .one().attention_marker_id as string
    );
    const ref = `attention:${s.chatSessionId}:${markerId}`;
    const reply = await post(`${itemPath(s, ref)}/reply`, s.ownerCookie, {
      content: 'Please run the checks first.',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const interaction = await runInDurableObject(store, async (_instance, state) =>
      state.storage.sql
        .exec(
          'SELECT state, encrypted_decision, decision_iv FROM interactions WHERE interaction_id = ?',
          interactionId
        )
        .one()
    );
    expect(interaction.state).toBe('answered');
    const decision = await decrypt(
      String(interaction.encrypted_decision),
      String(interaction.decision_iv),
      getCredentialEncryptionKey(testEnv)
    );
    expect(JSON.parse(decision)).toMatchObject({
      kind: 'selected_option',
      optionId: 'no-specific',
    });
    const snapshot = await s.project.getDurableExecutionSnapshot(s.chatSessionId);
    const delivery = snapshot.deliveries.find((entry) => entry.id === reply.body.deliveryId)!;
    expect(delivery).toMatchObject({
      sourceKind: 'inbox_reply',
      metadata: {
        inboxReplyPermission: {
          interactionId,
          answer: {
            decision: { kind: 'selected_option', optionId: 'no-specific' },
          },
        },
      },
    });
    // Delivery preparation runs inside this same ProjectData object. Its permission answer
    // authorizes through getSessionAccess on this object's stub: exercise that reentrant RPC.
    const replay = await runInDurableObject(s.project, async () =>
      rejectInboxReplyPermission(testEnv, {
        projectId: s.projectId,
        claim: { message: delivery, attemptId: 'permission-replay', mode: 'submit' },
      })
    );
    expect(replay).toBeNull();
    const afterReplay = await runInDurableObject(store, async (_instance, state) =>
      state.storage.sql
        .exec(
          'SELECT state, encrypted_decision, decision_iv FROM interactions WHERE interaction_id = ?',
          interactionId
        )
        .one()
    );
    expect(afterReplay).toEqual(interaction);
  });

  it('preserves every open question, keeps the header out of the transcript, and ordinary chat still closes questions', async () => {
    const s = await seed();
    const first = await ask(s, 'Which deployment window?');
    const other = await ask(s, 'Which region?');
    await expectInbox(s, [first.ref, other.ref], 2);

    const content = '  I have a follow-up, not an answer.\nPlease explain the tradeoff.  ';
    const reply = await post(`${itemPath(s, first.ref)}/reply`, s.ownerCookie, { content });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body).toMatchObject({
      ref: first.ref,
      status: 'queued',
      sessionId: s.chatSessionId,
    });
    const snapshot = await s.project.getDurableExecutionSnapshot(s.chatSessionId);
    const delivery = snapshot.deliveries.find((entry) => entry.id === reply.body.deliveryId);
    expect(delivery).toMatchObject({
      sourceKind: 'inbox_reply',
      metadata: { inboxRef: first.ref },
    });
    expect(delivery?.content).toContain('Which deployment window?');
    expect(delivery?.content).toContain('inbox_write resolve');
    expect(delivery?.content).toContain(content.trim());
    const transcript = await s.project.getMessages(s.chatSessionId, 100);
    expect(transcript.messages.find((entry) => entry.id === reply.body.messageId)?.content).toBe(
      content
    );
    const open = await testEnv.DATABASE.prepare(
      'SELECT id, status FROM asks WHERE project_id = ? ORDER BY id'
    )
      .bind(s.projectId)
      .all();
    expect(open.results).toHaveLength(2);
    expect(open.results.every((row) => row.status === 'open')).toBe(true);
    await expectInbox(s, [other.ref], 1);
    const detail = await get<InboxItemResponse>(itemPath(s, first.ref), s.ownerCookie);
    expect(detail.body.conversation?.replies).toEqual([
      expect.objectContaining({ id: reply.body.messageId, content, userId: s.ownerId }),
    ]);

    // Control enters the canonical chat prompt route, rather than calling the persistence helper.
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.use('/api/*', requireAuth(), requireApproved());
    const chats = new Hono<{ Bindings: Env }>();
    registerChatPromptRoute(chats);
    app.route('/api/projects/:projectId/sessions', chats);
    const ordinary = await app.request(
      `/api/projects/${s.projectId}/sessions/${s.chatSessionId}/prompt`,
      {
        method: 'POST',
        headers: { Cookie: s.ownerCookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Use the existing defaults for both questions.' }),
      },
      testEnv
    );
    expect(ordinary.status).toBe(202);
    const closed = await testEnv.DATABASE.prepare('SELECT status FROM asks WHERE project_id = ?')
      .bind(s.projectId)
      .all();
    expect(closed.results).toHaveLength(2);
    expect(closed.results.every((row) => row.status === 'answered')).toBe(true);
    await expectInbox(s, [], 0);
  });

  it('agent respond resurfaces with canonical discussion; update resurfaces again; resolve records the latest reply', async () => {
    const s = await seed();
    const filed = await callTool(s.token, 'inbox_write', {
      method: 'ask',
      title: 'Ship this release?',
      answer: 'confirm',
    });
    const item = filed.inboxItem as { id: string; ref: string };
    await expectInbox(s, [item.ref], 1);
    const first = await post(`${itemPath(s, item.ref)}/reply`, s.ownerCookie, {
      content: 'What changed?',
    });
    expect(first.status).toBe(202);
    await expectInbox(s, [], 0);
    const archived = await get<InboxListResponse>(
      `/api/projects/${s.projectId}/inbox?filter=archived`,
      s.ownerCookie
    );
    expect(archived.body.items).toEqual([
      expect.objectContaining({ ref: item.ref, status: 'open', withAgent: true }),
    ]);

    const responded = await callTool(s.token, 'inbox_write', {
      method: 'respond',
      ref: item.ref,
      body: 'Only the retry policy changed.',
      replyMessageId: first.body.messageId,
    });
    expect(responded).toMatchObject({ ref: item.ref });
    await expectInbox(s, [item.ref], 1);
    const detail = await get<InboxItemResponse>(itemPath(s, item.ref), s.ownerCookie);
    expect(detail.body.item.withAgent).toBe(false);
    expect(detail.body.conversation?.responses).toEqual([
      expect.objectContaining({
        body: 'Only the retry policy changed.',
        author: expect.objectContaining({ kind: 'agent', id: s.chatSessionId }),
      }),
    ]);
    expect(detail.body.conversation?.replies).toEqual([
      expect.objectContaining({ id: first.body.messageId, content: 'What changed?' }),
    ]);

    const second = await post(`${itemPath(s, item.ref)}/reply`, s.ownerCookie, {
      content: 'Ask about staging instead.',
    });
    expect(second.status).toBe(202);
    await expectInbox(s, [], 0);
    await callTool(s.token, 'inbox_write', {
      method: 'update',
      ref: item.ref,
      title: 'Deploy to staging?',
      replyMessageId: second.body.messageId,
    });
    await expectInbox(s, [item.ref], 1);
    const third = await post(`${itemPath(s, item.ref)}/reply`, s.ownerCookie, {
      content: 'Yes, staging is approved.',
    });
    expect(third.status).toBe(202);
    const resolved = await callTool(s.token, 'inbox_write', {
      method: 'resolve',
      ref: item.ref,
      replyMessageId: third.body.messageId,
    });
    expect(resolved).toEqual({
      ref: item.ref,
      status: 'answered',
      messageId: third.body.messageId,
    });
    const row = await testEnv.DATABASE.prepare('SELECT status, answer_json FROM asks WHERE id = ?')
      .bind(item.id)
      .first<{ status: string; answer_json: string }>();
    expect(row?.status).toBe('answered');
    expect(JSON.parse(row!.answer_json)).toEqual({ messageId: third.body.messageId });
    await expectInbox(s, [], 0);
  });
  it('continues past a page of human task discussion to the agent’s latest response', async () => {
    const s = await seed();
    const item = await ask(s, 'Which option should we use?');
    // Derived from the configured default intentionally: crossing the real adapter’s cap is
    // what exercises its cursor. A page of human threads must not swallow the agent’s response.
    for (let index = 0; index < DEFAULT_COMMENT_LIST_LIMIT_DEFAULT; index += 1) {
      await s.project.createInboxItemComment({
        itemId: item.id,
        body: `Earlier discussion ${index}`,
        actor: { kind: 'human', id: s.ownerId, name: 'Owner' },
      });
    }
    await callTool(s.token, 'inbox_write', {
      method: 'respond',
      ref: item.ref,
      body: 'Use option B.',
    });
    const first = await get<InboxItemResponse>(itemPath(s, item.ref), s.ownerCookie);
    expect(first.body.conversation?.responses).toEqual([]);
    expect(first.body.conversation?.hasMore).toBe(true);
    const cursor = first.body.conversation?.nextResponseCursor;
    expect(cursor).toBeGreaterThan(0);
    const second = await get<InboxItemResponse>(
      `${itemPath(s, item.ref)}?responseCursor=${cursor}`,
      s.ownerCookie
    );
    expect(second.body.conversation?.responses.map((thread) => thread.body)).toEqual([
      'Use option B.',
    ]);
    expect(second.body.conversation?.nextResponseCursor).toBeNull();
  });

  it('pages canonical replies backwards without duplicates and keeps each page chronological', async () => {
    const previousLimit = testEnv.CHAT_SESSION_MESSAGE_LIMIT;
    testEnv.CHAT_SESSION_MESSAGE_LIMIT = '2';
    try {
      const s = await seed();
      const item = await ask(s, 'Which release should we ship?');
      const ids: string[] = [];
      // Two full pages and a remainder exercise the real chat page cap and exact cursor.
      for (let index = 0; index < 5; index += 1) {
        const sent = await post(`${itemPath(s, item.ref)}/reply`, s.ownerCookie, {
          content: `Reply ${index}`,
        });
        expect(sent.status).toBe(202);
        ids.push(String(sent.body.messageId));
      }
      let cursor: string | null = null;
      const received: string[] = [];
      for (const expected of [ids.slice(3), ids.slice(1, 3), ids.slice(0, 1)]) {
        const suffix = cursor ? `?replyCursor=${encodeURIComponent(cursor)}` : '';
        const page = await get<InboxItemResponse>(
          `${itemPath(s, item.ref)}${suffix}`,
          s.ownerCookie
        );
        expect(page.status).toBe(200);
        const conversation = page.body.conversation!;
        expect(conversation.replies.map((reply) => reply.id)).toEqual(expected);
        expect(conversation.replies.map((reply) => reply.content)).toEqual(
          expected.map((id) => `Reply ${ids.indexOf(id)}`)
        );
        received.push(...conversation.replies.map((reply) => reply.id));
        cursor = conversation.nextReplyCursor;
        expect(conversation.hasMore).toBe(received.length < ids.length);
      }
      expect(cursor).toBeNull();
      expect(new Set(received).size).toBe(5);
      expect([...received].sort()).toEqual([...ids].sort());
    } finally {
      if (previousLimit === undefined) delete testEnv.CHAT_SESSION_MESSAGE_LIMIT;
      else testEnv.CHAT_SESSION_MESSAGE_LIMIT = previousLimit;
    }
  });

  it('continues past empty malformed message pages to an older canonical reply', async () => {
    const previousLimit = testEnv.CHAT_SESSION_MESSAGE_LIMIT;
    testEnv.CHAT_SESSION_MESSAGE_LIMIT = '2';
    try {
      const s = await seed();
      const item = await ask(s, 'Which release should we ship?');
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const sent = await post(`${itemPath(s, item.ref)}/reply`, s.ownerCookie, {
          content: `Reply ${index}`,
        });
        expect(sent.status).toBe(202);
        ids.push(String(sent.body.messageId));
      }
      await runInDurableObject(s.project, async (_instance, state) => {
        // SQLite permits a BLOB in this nullable TEXT column; the real row parser rejects it.
        state.storage.sql.exec(
          "UPDATE chat_messages SET tool_metadata = X'00' WHERE id IN (?, ?, ?, ?)",
          ...ids.slice(1)
        );
      });
      let cursor: string | null = null;
      const cursors: string[] = [];
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const suffix = cursor ? `?replyCursor=${encodeURIComponent(cursor)}` : '';
        const page = await get<InboxItemResponse>(
          `${itemPath(s, item.ref)}${suffix}`,
          s.ownerCookie
        );
        expect(page.status).toBe(200);
        const conversation = page.body.conversation!;
        expect(conversation.replies.map((reply) => reply.id)).toEqual(
          pageIndex < 2 ? [] : [ids[0]]
        );
        expect(conversation.hasMore).toBe(pageIndex < 2);
        cursor = conversation.nextReplyCursor;
        if (pageIndex < 2) {
          expect(cursor).toBeTypeOf('string');
          expect(cursors).not.toContain(cursor);
          cursors.push(cursor!);
        }
      }
      expect(cursor).toBeNull();
    } finally {
      if (previousLimit === undefined) delete testEnv.CHAT_SESSION_MESSAGE_LIMIT;
      else testEnv.CHAT_SESSION_MESSAGE_LIMIT = previousLimit;
    }
  });
});
