/** Malformed anchored rows must not trap the real inbox detail route on one page. */
import type {
  InboxAgentItem,
  InboxCountResponse,
  InboxItemResponse,
} from '@simple-agent-manager/shared';
import { DEFAULT_COMMENT_LIST_LIMIT_DEFAULT } from '@simple-agent-manager/shared';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { callTool, fetchMock, get, post, seed, testEnv } from './helpers/inbox-harness';

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it('advances bounded empty malformed response pages to the valid agent response', async () => {
  const s = await seed();
  const filed = await callTool(s.token, 'inbox_write', { method: 'ask', title: 'Which option?' });
  const item = filed.inboxItem as { id: string; ref: string };
  const badIds: string[] = [];
  for (let index = 0; index < 2 * DEFAULT_COMMENT_LIST_LIMIT_DEFAULT; index += 1) {
    const result = await s.project.createInboxItemComment({
      itemId: item.id,
      body: `Malformed response ${index}`,
      actor: { kind: 'agent', id: s.agentSessionId, name: 'Agent' },
    });
    badIds.push(result.thread.id);
  }
  const good = await s.project.createInboxItemComment({
    itemId: item.id,
    body: 'Use option B.',
    actor: { kind: 'agent', id: s.agentSessionId, name: 'Agent' },
  });
  await runInDurableObject(s.project, async (_instance, state) => {
    for (const id of badIds) {
      // Real SQLite accepts a BLOB in TEXT; the canonical thread parser rejects it.
      state.storage.sql.exec("UPDATE anchored_comment_threads SET body = X'00' WHERE id = ?", id);
    }
  });
  const base = `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(item.ref)}`;
  let cursor: number | null = null;
  const cursors: number[] = [];
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const response = await get<InboxItemResponse>(
      `${base}${cursor === null ? '' : `?responseCursor=${cursor}`}`,
      s.ownerCookie
    );
    expect(response.status).toBe(200);
    const conversation = response.body.conversation!;
    // The read stays capped; it must not scan ahead to fill an empty hydrated page.
    expect(conversation.responses.map((thread) => thread.id)).toEqual(
      pageIndex < 2 ? [] : [good.thread.id]
    );
    expect(conversation.hasMore).toBe(pageIndex < 2);
    cursor = conversation.nextResponseCursor;
    if (pageIndex < 2) {
      expect(cursor).toBeTypeOf('number');
      expect(cursors).not.toContain(cursor);
      cursors.push(cursor!);
    }
  }
  expect(cursor).toBeNull();
  const count = await get<InboxCountResponse>(
    `/api/projects/${s.projectId}/inbox/count`,
    s.ownerCookie
  );
  expect(count.body.needsYou).toBe(1);
});

it.each([
  { replies: 3, responses: 1 },
  { replies: 1, responses: DEFAULT_COMMENT_LIST_LIMIT_DEFAULT + 1 },
  { replies: 3, responses: DEFAULT_COMMENT_LIST_LIMIT_DEFAULT + 1 },
])(
  'paginates streams independently with $replies replies and $responses responses',
  async (counts) => {
    const previousLimit = testEnv.CHAT_SESSION_MESSAGE_LIMIT;
    testEnv.CHAT_SESSION_MESSAGE_LIMIT = '2';
    try {
      const s = await seed();
      const filed = await callTool(s.token, 'inbox_write', {
        method: 'ask',
        title: 'Which release?',
      });
      const item = filed.inboxItem as { id: string; ref: string };
      const base = `/api/projects/${s.projectId}/inbox/items/${encodeURIComponent(item.ref)}`;
      const replyIds: string[] = [];
      const responseIds: string[] = [];
      for (let index = 0; index < counts.replies; index += 1) {
        const sent = await post(`${base}/reply`, s.ownerCookie, { content: `Reply ${index}` });
        expect(sent.status).toBe(202);
        replyIds.push(String(sent.body.messageId));
      }
      for (let index = 0; index < counts.responses; index += 1) {
        const response = await s.project.createInboxItemComment({
          itemId: item.id,
          body: `Response ${index}`,
          actor: { kind: 'agent', id: s.agentSessionId, name: 'Agent' },
        });
        responseIds.push(response.thread.id);
      }
      let replyCursor: string | null = null;
      let responseCursor: number | null = null;
      const seenReplies: string[] = [];
      const seenResponses: string[] = [];
      const seenPending: string[] = [];
      for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
        const query = new URLSearchParams();
        if (replyCursor !== null) query.set('replyCursor', replyCursor);
        if (responseCursor !== null) query.set('responseCursor', String(responseCursor));
        const page = await get<InboxItemResponse>(`${base}?${query}`, s.ownerCookie);
        expect(page.status).toBe(200);
        const conversation = page.body.conversation!;
        const agentPage = await callTool(s.token, 'inbox_read', {
          method: 'get',
          ref: item.ref,
          ...(replyCursor === null ? {} : { replyCursor }),
          ...(responseCursor === null ? {} : { responseCursor }),
        });
        const agentItem = agentPage.item as InboxAgentItem;
        expect(agentItem.conversation).toEqual(conversation);
        expect(agentItem.pendingReplyIds?.sort()).toEqual(
          conversation.replies.map((r) => r.id).sort()
        );
        seenReplies.push(...conversation.replies.map((r) => r.id));
        seenResponses.push(...conversation.responses.map((r) => r.id));
        seenPending.push(...agentItem.pendingReplyIds!);
        expect(conversation.hasMore).toBe(pageIndex === 0);
        replyCursor = conversation.nextReplyCursor;
        responseCursor = conversation.nextResponseCursor;
      }
      expect(replyCursor).toBeNull();
      expect(responseCursor).toBeNull();
      expect(seenReplies.sort()).toEqual(replyIds.sort());
      expect(seenResponses.sort()).toEqual(responseIds.sort());
      expect(seenPending.sort()).toEqual(replyIds.sort());
    } finally {
      if (previousLimit === undefined) delete testEnv.CHAT_SESSION_MESSAGE_LIMIT;
      else testEnv.CHAT_SESSION_MESSAGE_LIMIT = previousLimit;
    }
  }
);
