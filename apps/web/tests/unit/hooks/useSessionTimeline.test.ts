import type { NotificationResponse } from '@simple-agent-manager/shared';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionTimeline } from '../../../src/components/project-message-view/useSessionTimeline';
import type { ActivityEventResponse, ChatMessageResponse } from '../../../src/lib/api/sessions';

// Mock the API module
vi.mock('../../../src/lib/api/sessions', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/api/sessions')>();
  return {
    ...original,
    listActivityEvents: vi.fn(),
    listChatMessages: vi.fn(),
  };
});

vi.mock('../../../src/lib/api/notifications', () => ({
  listNotifications: vi.fn(),
}));

// Import the mocked function for assertions
import { listNotifications } from '../../../src/lib/api/notifications';
import { listActivityEvents, listChatMessages } from '../../../src/lib/api/sessions';
const mockListActivityEvents = vi.mocked(listActivityEvents);
const mockListChatMessages = vi.mocked(listChatMessages);
const mockListNotifications = vi.mocked(listNotifications);

function makeMessage(id: string, createdAt: number): ChatMessageResponse {
  return {
    id,
    sessionId: 'sess-1',
    role: 'user',
    content: `Message ${id}`,
    toolMetadata: null,
    createdAt,
  };
}

function makeEvent(id: string, eventType: string, createdAt: number): ActivityEventResponse {
  return {
    id,
    eventType,
    actorType: 'system',
    actorId: null,
    workspaceId: null,
    sessionId: 'sess-1',
    taskId: null,
    payload: null,
    createdAt,
  };
}

function makeNotification(id: string, createdAt: number, overrides: Partial<NotificationResponse> = {}): NotificationResponse {
  return {
    id,
    projectId: 'proj-1',
    taskId: 'task-1',
    sessionId: 'sess-1',
    type: 'progress',
    urgency: 'low',
    title: 'Progress update',
    body: `Notification ${id}`,
    actionUrl: null,
    metadata: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date(createdAt).toISOString(),
    ...overrides,
  };
}

describe('useSessionTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListActivityEvents.mockResolvedValue({ events: [], hasMore: false });
    mockListChatMessages.mockResolvedValue({ messages: [], hasMore: false });
    mockListNotifications.mockResolvedValue({ notifications: [], unreadCount: 0, nextCursor: null });
  });

  it('does not fetch events when disabled', () => {
    renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], false, new Map())
    );

    expect(mockListActivityEvents).not.toHaveBeenCalled();
    expect(mockListChatMessages).not.toHaveBeenCalled();
    expect(mockListNotifications).not.toHaveBeenCalled();
  });

  it('fetches server messages and events when enabled', async () => {
    mockListChatMessages.mockResolvedValue({
      messages: [makeMessage('m1', 1000)],
      hasMore: false,
    });
    mockListActivityEvents.mockResolvedValue({
      events: [makeEvent('e1', 'session.started', 1000)],
      hasMore: false,
    });

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], true, new Map())
    );

    // Wait for the fetch to complete
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockListChatMessages).toHaveBeenCalledWith('proj-1', 'sess-1', {
          before: undefined,
          roles: ['user'],
          compact: true,
        });
        expect(mockListActivityEvents).toHaveBeenCalledWith('proj-1', {
          sessionId: 'sess-1',
          limit: 100,
        });
        expect(mockListNotifications).toHaveBeenCalledWith({
          projectId: 'proj-1',
          sessionId: 'sess-1',
          type: 'progress',
          cursor: undefined,
        });
      });
    });

    expect(result.current.loading).toBe(false);
  });

  it('uses server-fetched messages instead of only the loaded chat messages', async () => {
    mockListChatMessages.mockResolvedValue({
      messages: [makeMessage('server-old-user-turn', 500)],
      hasMore: false,
    });

    const loadedMessages = [makeMessage('loaded-ui-message', 1000)];

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', loadedMessages, true, new Map())
    );

    await act(async () => {
      await vi.waitFor(() => {
        expect(mockListChatMessages).toHaveBeenCalled();
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.entries.some((entry) => entry.id === 'msg-server-old-user-turn')).toBe(true);
  });

  it('paginates server user messages until history is exhausted', async () => {
    mockListChatMessages
      .mockResolvedValueOnce({
        messages: [makeMessage('newer', 2000)],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        messages: [makeMessage('older', 1000)],
        hasMore: false,
      });

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], true, new Map())
    );

    await act(async () => {
      await vi.waitFor(() => {
        expect(mockListChatMessages).toHaveBeenCalledTimes(2);
      });
    });

    expect(mockListChatMessages).toHaveBeenNthCalledWith(2, 'proj-1', 'sess-1', {
      before: 2000,
      roles: ['user'],
      compact: true,
    });
    expect(result.current.entries.map((entry) => entry.id)).toEqual(['msg-older', 'msg-newer']);
  });

  it('returns session progress notifications as timeline entries', async () => {
    mockListNotifications.mockResolvedValue({
      notifications: [
        makeNotification('n1', 1500, {
          title: 'Progress: Tests',
          metadata: { fullMessage: 'Ran focused timeline tests' },
        }),
      ],
      unreadCount: 1,
      nextCursor: null,
    });

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], true, new Map())
    );

    await act(async () => {
      await vi.waitFor(() => {
        expect(mockListNotifications).toHaveBeenCalledWith({
          projectId: 'proj-1',
          sessionId: 'sess-1',
          type: 'progress',
          cursor: undefined,
        });
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.entries.find((entry) => entry.id === 'notif-n1')).toMatchObject({
      kind: 'progress_notification',
      notificationId: 'n1',
      text: 'Ran focused timeline tests',
    });
  });

  it('paginates progress notifications until history is exhausted', async () => {
    mockListNotifications
      .mockResolvedValueOnce({
        notifications: [makeNotification('newer', 2000, { body: 'Newer progress' })],
        unreadCount: 2,
        nextCursor: 'cursor-older',
      })
      .mockResolvedValueOnce({
        notifications: [makeNotification('older', 1000, { body: 'Older progress' })],
        unreadCount: 2,
        nextCursor: null,
      });

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], true, new Map())
    );

    await act(async () => {
      await vi.waitFor(() => {
        expect(mockListNotifications).toHaveBeenCalledTimes(2);
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockListNotifications).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      type: 'progress',
      cursor: undefined,
    });
    expect(mockListNotifications).toHaveBeenNthCalledWith(2, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      type: 'progress',
      cursor: 'cursor-older',
    });
    expect(result.current.entries.map((entry) => entry.id)).toEqual(['notif-older', 'notif-newer']);
  });

  it('returns entries combining messages and events when showContext is true', async () => {
    const resolvedEvents = [makeEvent('e1', 'workspace.created', 500)];
    mockListChatMessages.mockResolvedValue({
      messages: [makeMessage('m1', 1000)],
      hasMore: false,
    });
    mockListActivityEvents.mockResolvedValue({
      events: resolvedEvents,
      hasMore: false,
    });

    const indexMap = new Map([['m1', 0]]);

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], true, indexMap)
    );

    // Wait for fetch to settle
    await act(async () => {
      // Flush microtasks
      await new Promise((r) => setTimeout(r, 50));
    });

    // Toggle showContext on
    act(() => {
      result.current.setShowContext(true);
    });

    // Should now include both messages and events
    expect(result.current.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('handles fetch errors gracefully without throwing', async () => {
    mockListActivityEvents.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], true, new Map())
    );

    // Wait for the rejected promise to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Should still work — entries will be empty, no error thrown
    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('provides showContext toggle', () => {
    mockListActivityEvents.mockResolvedValue({ events: [], hasMore: false });

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], false, new Map())
    );

    expect(result.current.showContext).toBe(false);

    act(() => {
      result.current.setShowContext(true);
    });

    expect(result.current.showContext).toBe(true);
  });
});
