/** Malformed anchored rows must not trap the real inbox detail route on one page. */
import type { InboxCountResponse, InboxItemResponse } from '@simple-agent-manager/shared';
import { DEFAULT_COMMENT_LIST_LIMIT_DEFAULT } from '@simple-agent-manager/shared';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { callTool, fetchMock, get, seed } from './helpers/inbox-harness';

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
  const count = await get<InboxCountResponse>(`/api/projects/${s.projectId}/inbox/count`, s.ownerCookie);
  expect(count.body.needsYou).toBe(1);
});
