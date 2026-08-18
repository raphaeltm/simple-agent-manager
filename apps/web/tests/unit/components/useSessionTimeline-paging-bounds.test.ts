/**
 * Regression tests for the timeline drawer's pagination bounds.
 *
 * `useSessionTimeline` used to fill the drawer with two `for(;;)` loops that
 * paged to exhaustion with no page cap. A server that keeps reporting
 * `hasMore` / `nextCursor` — or a cursor that stops advancing — pinned the
 * drawer in its loading state and issued requests forever.
 *
 * Both failure modes are exercised here: an always-`hasMore` server (bounded by
 * the page cap) and a server whose cursor never advances (bounded by the
 * non-advancing-cursor guard, which must trip well before the cap).
 */
import { DEFAULT_CHAT_TIMELINE_MAX_PAGES } from '@simple-agent-manager/shared';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listChatMessages: vi.fn(),
  listActivityEvents: vi.fn(),
  listNotifications: vi.fn(),
}));

vi.mock('../../../src/lib/api/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/sessions')>()),
  listChatMessages: mocks.listChatMessages,
  listActivityEvents: mocks.listActivityEvents,
}));

vi.mock('../../../src/lib/api/notifications', () => ({
  listNotifications: mocks.listNotifications,
}));

const { useSessionTimeline } =
  await import('../../../src/components/project-message-view/useSessionTimeline');

function makeMessage(id: string, createdAt: number) {
  return {
    id,
    sessionId: 'session-1',
    role: 'user' as const,
    content: `message ${id}`,
    toolMetadata: null,
    createdAt,
    sequence: null,
  };
}

describe('useSessionTimeline — pagination bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listActivityEvents.mockResolvedValue({ events: [] });
    mocks.listNotifications.mockResolvedValue({ notifications: [], nextCursor: null });
  });

  it('stops paging messages at the page cap when the server always reports hasMore', async () => {
    // Every page advances the cursor and claims there is more, forever.
    let seq = 1_000_000;
    mocks.listChatMessages.mockImplementation(() => {
      seq -= 1000;
      return Promise.resolve({ messages: [makeMessage(`m-${seq}`, seq)], hasMore: true });
    });

    const { result } = renderHook(() => useSessionTimeline('proj-1', 'session-1', [], true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Bounded, not unbounded. Without the cap this call count would never settle.
    expect(mocks.listChatMessages).toHaveBeenCalledTimes(DEFAULT_CHAT_TIMELINE_MAX_PAGES);
  });

  it('stops paging messages when the cursor stops advancing', async () => {
    // Pathological server: same page forever, so `before` never moves. The page
    // cap alone would still allow MAX_PAGES identical requests; the
    // non-advancing-cursor guard must cut it off after the second.
    mocks.listChatMessages.mockResolvedValue({
      messages: [makeMessage('m-stuck', 5000)],
      hasMore: true,
    });

    const { result } = renderHook(() => useSessionTimeline('proj-1', 'session-1', [], true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mocks.listChatMessages).toHaveBeenCalledTimes(2);
    expect(mocks.listChatMessages.mock.calls.length).toBeLessThan(DEFAULT_CHAT_TIMELINE_MAX_PAGES);
  });

  it('stops paging notifications at the page cap when nextCursor never ends', async () => {
    mocks.listChatMessages.mockResolvedValue({ messages: [], hasMore: false });

    let cursor = 0;
    mocks.listNotifications.mockImplementation(() => {
      cursor += 1;
      return Promise.resolve({
        notifications: [{ id: `n-${cursor}`, title: 'Progress', createdAt: cursor }],
        nextCursor: `cursor-${cursor}`,
      });
    });

    const { result } = renderHook(() => useSessionTimeline('proj-1', 'session-1', [], true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mocks.listNotifications).toHaveBeenCalledTimes(DEFAULT_CHAT_TIMELINE_MAX_PAGES);
  });

  it('stops paging notifications when nextCursor stops advancing', async () => {
    mocks.listChatMessages.mockResolvedValue({ messages: [], hasMore: false });
    mocks.listNotifications.mockResolvedValue({
      notifications: [{ id: 'n-stuck', title: 'Progress', createdAt: 1 }],
      nextCursor: 'cursor-stuck',
    });

    const { result } = renderHook(() => useSessionTimeline('proj-1', 'session-1', [], true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mocks.listNotifications).toHaveBeenCalledTimes(2);
  });

  it('still pages to completion for a normal finite history', async () => {
    // Guard against over-eager bounding: a well-behaved server must still be
    // fully drained, or the drawer would silently lose timeline entries.
    mocks.listChatMessages
      .mockResolvedValueOnce({ messages: [makeMessage('m-3', 3000)], hasMore: true })
      .mockResolvedValueOnce({ messages: [makeMessage('m-2', 2000)], hasMore: true })
      .mockResolvedValueOnce({ messages: [makeMessage('m-1', 1000)], hasMore: false });

    const { result } = renderHook(() => useSessionTimeline('proj-1', 'session-1', [], true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mocks.listChatMessages).toHaveBeenCalledTimes(3);
    // All three pages made it into the timeline, oldest first.
    expect(result.current.entries).toHaveLength(3);
  });
});
