import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNotifications } from '../../../src/hooks/useNotifications';

// Regression: NotificationCenter renders in the app shell on every page and
// derives tab counts via `notifications.filter(...)`. A notifications payload
// without the expected array (proxy error body, API drift) used to poison the
// state with `undefined` and crash the ENTIRE app through the ErrorBoundary.
// The hook must degrade to an empty list instead.

const mockListNotifications = vi.fn();

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listNotifications: (...args: unknown[]) => mockListNotifications(...args),
  getNotificationUnreadCount: () => Promise.resolve({ count: 0 }),
  getNotificationWsUrl: () => 'ws://localhost:9/ws',
}));

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor() {
    FakeWebSocket.last = this;
  }
  close() {}
  send() {}
}

describe('useNotifications — malformed payload resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  it('degrades to an empty list when the response has no notifications array', async () => {
    mockListNotifications.mockResolvedValue({ error: 'upstream unavailable' });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.loading).toBe(false));
    // The old behavior stored `undefined`, so `.filter` in NotificationCenter threw.
    expect(Array.isArray(result.current.notifications)).toBe(true);
    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.hasMore).toBe(false);
  });

  it('ignores WebSocket frames whose notification payload is malformed', async () => {
    mockListNotifications.mockResolvedValue({
      notifications: [],
      unreadCount: 0,
      nextCursor: null,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const ws = FakeWebSocket.last!;
    // Open the socket, then push a notification.new with no notification object
    // and an updated frame with a junk payload — neither may poison the list.
    await waitFor(() => expect(ws.onopen).not.toBeNull());
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'notification.new' }) });
    ws.onmessage?.({ data: JSON.stringify({ type: 'notification.updated', notification: 42 }) });

    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
    // Every dropped frame is logged so a real backend/frontend contract drift
    // is diagnosable instead of silently vanishing.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('ignores a WebSocket frame with an invalid enum value instead of coercing it', async () => {
    mockListNotifications.mockResolvedValue({
      notifications: [],
      unreadCount: 0,
      nextCursor: null,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const ws = FakeWebSocket.last!;
    await waitFor(() => expect(ws.onopen).not.toBeNull());
    ws.onopen?.();

    // `urgency: 'info'` is not one of the canonical NOTIFICATION_URGENCIES —
    // the full-shape validation must reject the whole frame, not just the bad field.
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'notification.new',
        notification: {
          id: 'n-bad',
          projectId: null,
          taskId: null,
          sessionId: null,
          type: 'task_complete',
          urgency: 'info',
          title: 'Bad',
          body: null,
          actionUrl: null,
          metadata: null,
          readAt: null,
          dismissedAt: null,
          createdAt: '2026-07-17T00:00:00.000Z',
        },
      }),
    });

    expect(result.current.notifications).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('applies a well-formed notification.new WebSocket frame to state', async () => {
    mockListNotifications.mockResolvedValue({
      notifications: [],
      unreadCount: 0,
      nextCursor: null,
    });

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const ws = FakeWebSocket.last!;
    await waitFor(() => expect(ws.onopen).not.toBeNull());
    ws.onopen?.();

    const notification = {
      id: 'n2',
      projectId: null,
      taskId: null,
      sessionId: null,
      type: 'task_complete',
      urgency: 'medium',
      title: 'Deployed',
      body: null,
      actionUrl: null,
      metadata: null,
      readAt: null,
      dismissedAt: null,
      createdAt: '2026-07-17T00:00:00.000Z',
    };
    ws.onmessage?.({ data: JSON.stringify({ type: 'notification.new', notification }) });

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.notifications[0]).toEqual(notification);
    expect(result.current.unreadCount).toBe(1);
  });

  it('applies a well-formed notification.unread_count WebSocket frame to state', async () => {
    mockListNotifications.mockResolvedValue({
      notifications: [],
      unreadCount: 0,
      nextCursor: null,
    });

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const ws = FakeWebSocket.last!;
    await waitFor(() => expect(ws.onopen).not.toBeNull());
    ws.onopen?.();

    ws.onmessage?.({ data: JSON.stringify({ type: 'notification.unread_count', count: 7 }) });

    await waitFor(() => expect(result.current.unreadCount).toBe(7));
  });

  it('keeps a valid payload intact', async () => {
    const items = [
      {
        id: 'n1',
        projectId: null,
        taskId: null,
        sessionId: null,
        type: 'task_complete',
        // 'info' is not one of NOTIFICATION_URGENCIES ('high' | 'medium' |
        // 'low') — this fixture previously used it and still passed, because
        // the REST path only checked `Array.isArray(...)` and never validated
        // individual items. Use a genuinely valid urgency so this test proves
        // what its name claims.
        urgency: 'low',
        title: 'Done',
        body: null,
        actionUrl: null,
        metadata: null,
        readAt: null,
        dismissedAt: null,
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    ];
    mockListNotifications.mockResolvedValue({
      notifications: items,
      unreadCount: 1,
      nextCursor: null,
    });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]).toEqual(items[0]);
    expect(result.current.unreadCount).toBe(1);
  });

  it('drops malformed items from a REST response while keeping the valid ones', async () => {
    const goodOne = {
      id: 'n-good-1',
      projectId: null,
      taskId: null,
      sessionId: null,
      type: 'task_complete',
      urgency: 'high',
      title: 'First good notification',
      body: null,
      actionUrl: null,
      metadata: null,
      readAt: null,
      dismissedAt: null,
      createdAt: '2026-07-17T00:00:00.000Z',
    };
    // Same invalid-urgency shape the WS path rejects — proves the REST path
    // now enforces the same contract instead of trusting `Array.isArray` alone.
    const badOne = { ...goodOne, id: 'n-bad', urgency: 'info' };
    const goodTwo = { ...goodOne, id: 'n-good-2', title: 'Second good notification' };

    mockListNotifications.mockResolvedValue({
      notifications: [goodOne, badOne, goodTwo],
      unreadCount: 3,
      nextCursor: null,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.notifications.map((n) => n.id)).toEqual(['n-good-1', 'n-good-2']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('1 malformed notification item');
    warnSpy.mockRestore();
  });
});
