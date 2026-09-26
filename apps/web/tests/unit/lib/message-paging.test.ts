import { DEFAULT_CHAT_DELTA_MAX_PAGES } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessageResponse, ChatSessionDetailResponse } from '../../../src/lib/api';

const mocks = vi.hoisted(() => ({ getChatSession: vi.fn() }));

vi.mock('../../../src/lib/api', () => ({ getChatSession: mocks.getChatSession }));

const { newestPersistedCursor, oldestPersistedCursor, refreshCachedTranscript } = await import(
  '../../../src/lib/message-paging'
);

function persisted(id: string, createdAt: number, sequence = createdAt): ChatMessageResponse {
  return { id, sessionId: 's-1', role: 'assistant', content: id, toolMetadata: null, createdAt, sequence };
}

function optimistic(id: string, createdAt: number): ChatMessageResponse {
  return { id, sessionId: 's-1', role: 'user', content: id, toolMetadata: null, createdAt };
}

function page(messages: ChatMessageResponse[], hasMore: boolean): ChatSessionDetailResponse {
  return { messages, hasMore } as ChatSessionDetailResponse;
}

describe('persisted-row cursors', () => {
  const rows = [
    optimistic('optimistic-first', 50),
    persisted('oldest', 100, 1),
    persisted('newest', 200, 2),
    optimistic('optimistic-last', 900),
  ];

  it('skips optimistic rows at either edge', () => {
    expect(oldestPersistedCursor(rows)).toBe('[100,1,"oldest"]');
    expect(newestPersistedCursor(rows)).toBe('[200,2,"newest"]');
  });

  it('has no cursor when nothing has been persisted', () => {
    expect(newestPersistedCursor([optimistic('optimistic-only', 5)])).toBeUndefined();
    expect(oldestPersistedCursor([])).toBeUndefined();
  });
});

describe('refreshCachedTranscript', () => {
  beforeEach(() => mocks.getChatSession.mockReset());

  it('returns null so the caller reloads when the cache has no persisted anchor', async () => {
    const cached = page([optimistic('optimistic-only', 5)], false);
    expect(await refreshCachedTranscript('p-1', 's-1', cached)).toBeNull();
    expect(mocks.getChatSession).not.toHaveBeenCalled();
  });

  it('fails visibly when a page does not advance the cursor', async () => {
    const stuck = persisted('stuck', 200);
    mocks.getChatSession
      .mockResolvedValueOnce(page([stuck], true))
      .mockResolvedValueOnce(page([stuck], true));

    await expect(
      refreshCachedTranscript('p-1', 's-1', page([persisted('cached', 100)], false))
    ).rejects.toThrow('stopped after 2 pages');
    expect(mocks.getChatSession).toHaveBeenCalledTimes(2);
  });

  it('fails visibly instead of returning a partial range when the page bound is reached', async () => {
    let createdAt = 100;
    mocks.getChatSession.mockImplementation(async () =>
      page([persisted(`row-${createdAt}`, (createdAt += 1))], true)
    );

    await expect(
      refreshCachedTranscript('p-1', 's-1', page([persisted('cached', 100)], false))
    ).rejects.toThrow(
      `Message refresh for session s-1 stopped after ${DEFAULT_CHAT_DELTA_MAX_PAGES} pages`
    );
    expect(mocks.getChatSession).toHaveBeenCalledTimes(DEFAULT_CHAT_DELTA_MAX_PAGES);
  });
});
