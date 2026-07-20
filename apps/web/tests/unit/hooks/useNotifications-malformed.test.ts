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
    mockListNotifications.mockResolvedValue({ notifications: [], unreadCount: 0, nextCursor: null });

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
  });

  it('keeps a valid payload intact', async () => {
    const items = [
      {
        id: 'n1', projectId: null, taskId: null, sessionId: null, type: 'task_complete',
        urgency: 'info', title: 'Done', body: null, actionUrl: null, metadata: null,
        readAt: null, dismissedAt: null, createdAt: '2026-07-17T00:00:00.000Z',
      },
    ];
    mockListNotifications.mockResolvedValue({ notifications: items, unreadCount: 1, nextCursor: null });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.unreadCount).toBe(1);
  });
});
