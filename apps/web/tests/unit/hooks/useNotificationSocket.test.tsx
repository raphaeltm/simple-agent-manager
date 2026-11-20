/**
 * The app's notification socket (slice C): it refreshes instead of polling. A frame about an ask
 * refreshes the inbox lists and counts; an FYI frame refreshes only the notification lists; a
 * burst is coalesced into one refresh; a reconnect catches up; malformed frames are dropped.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getNotificationWsUrl: () => 'ws://localhost:9/ws',
}));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));

const { useNotificationSocket, NOTIFICATION_REFRESH_DEBOUNCE_MS } =
  await import('../../../src/hooks/useNotificationSocket');

class FakeWebSocket {
  static OPEN = 1;
  static sockets: FakeWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor() {
    FakeWebSocket.sockets.push(this);
  }
  close() {}
  send() {}
}

function notification(type: string) {
  return {
    id: `n-${type}`,
    projectId: 'p1',
    taskId: null,
    sessionId: 's1',
    type,
    urgency: 'high',
    title: 'T',
    body: null,
    actionUrl: null,
    metadata: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
  };
}

let client: QueryClient;
let invalidated: unknown[][];

function setup() {
  client = new QueryClient();
  invalidated = [];
  const original = client.invalidateQueries.bind(client);
  vi.spyOn(client, 'invalidateQueries').mockImplementation((filters, options) => {
    invalidated.push([...(filters?.queryKey ?? [])]);
    return original(filters, options);
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(() => useNotificationSocket(), { wrapper });
  const socket = FakeWebSocket.sockets.at(-1)!;
  act(() => socket.onopen?.());
  return socket;
}

async function frame(socket: FakeWebSocket, payload: unknown) {
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify(payload) });
  });
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NOTIFICATION_REFRESH_DEBOUNCE_MS + 10);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.sockets = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const INBOX_LISTS = ['auth', 'user-1', 'inbox', 'list'];
const INBOX_COUNTS = ['auth', 'user-1', 'inbox', 'count'];
// The open item, so an agent's response shows in its conversation.
const INBOX_ITEMS = ['auth', 'user-1', 'inbox', 'item'];
const NOTIFICATIONS = ['auth', 'user-1', 'notifications'];

describe('useNotificationSocket', () => {
  it('a new ask refreshes the inbox lists, counts and notification lists once', async () => {
    const socket = setup();
    await frame(socket, { type: 'notification.new', notification: notification('needs_input') });
    await frame(socket, { type: 'notification.new', notification: notification('secret_request') });
    expect(invalidated).toEqual([]);
    await settle();
    expect(invalidated).toEqual([NOTIFICATIONS, INBOX_LISTS, INBOX_COUNTS, INBOX_ITEMS]);
  });

  it('an FYI notification refreshes only the notification lists', async () => {
    const socket = setup();
    await frame(socket, { type: 'notification.new', notification: notification('task_complete') });
    await frame(socket, { type: 'notification.read', notificationId: 'n-1' });
    await settle();
    expect(invalidated).toEqual([NOTIFICATIONS]);
  });

  it('a reconnect catches up on the inbox', async () => {
    const socket = setup();
    await settle();
    expect(invalidated).toEqual([]);
    act(() => socket.onopen?.());
    await settle();
    expect(invalidated).toEqual([NOTIFICATIONS, INBOX_LISTS, INBOX_COUNTS, INBOX_ITEMS]);
  });

  it('drops malformed frames and logs them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = setup();
    await frame(socket, { type: 'notification.new' });
    await frame(socket, { type: 'notification.updated', notification: 42 });
    await act(async () => {
      socket.onmessage?.({ data: 'not json' });
    });
    await settle();
    expect(invalidated).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
