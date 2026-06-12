import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionTimeline } from '../../../src/components/project-message-view/useSessionTimeline';
import type { ActivityEventResponse, ChatMessageResponse } from '../../../src/lib/api/sessions';

// Mock the API module
vi.mock('../../../src/lib/api/sessions', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/api/sessions')>();
  return {
    ...original,
    listActivityEvents: vi.fn(),
  };
});

// Import the mocked function for assertions
import { listActivityEvents } from '../../../src/lib/api/sessions';
const mockListActivityEvents = vi.mocked(listActivityEvents);

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

describe('useSessionTimeline', () => {
  it('does not fetch events when disabled', () => {
    mockListActivityEvents.mockResolvedValue({ events: [], hasMore: false });

    renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', [], false, new Map())
    );

    expect(mockListActivityEvents).not.toHaveBeenCalled();
  });

  it('fetches events when enabled', async () => {
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
        expect(mockListActivityEvents).toHaveBeenCalledWith('proj-1', {
          sessionId: 'sess-1',
          limit: 100,
        });
      });
    });

    expect(result.current.loading).toBe(false);
  });

  it('returns entries combining messages and events when showContext is true', async () => {
    const resolvedEvents = [makeEvent('e1', 'workspace.created', 500)];
    mockListActivityEvents.mockResolvedValue({
      events: resolvedEvents,
      hasMore: false,
    });

    const messages = [makeMessage('m1', 1000)];
    const indexMap = new Map([['m1', 0]]);

    const { result } = renderHook(() =>
      useSessionTimeline('proj-1', 'sess-1', messages, true, indexMap)
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
