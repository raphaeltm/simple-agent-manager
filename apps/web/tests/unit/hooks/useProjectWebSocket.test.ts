import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProjectWebSocket } from '../../../src/hooks/useProjectWebSocket';

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

interface MockWebSocket {
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  url: string;
}

let mockWs: MockWebSocket;
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  mockWs = {
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    readyState: 0, // CONNECTING
    close: vi.fn(),
    send: vi.fn(),
    url: '',
  };

  globalThis.WebSocket = vi.fn((url: string) => {
    mockWs.url = url;
    return mockWs;
  }) as unknown as typeof WebSocket;

  // Assign static constants
  (globalThis.WebSocket as unknown as Record<string, number>).OPEN = 1;
  (globalThis.WebSocket as unknown as Record<string, number>).CLOSED = 3;

  vi.useFakeTimers();
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateOpen() {
  mockWs.readyState = 1; // OPEN
  mockWs.onopen?.(new Event('open'));
}

function simulateMessage(data: Record<string, unknown>) {
  mockWs.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
}

function simulateClose(code = 1006) {
  mockWs.readyState = 3; // CLOSED
  mockWs.onclose?.({ code } as CloseEvent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useProjectWebSocket', () => {
  const PROJECT_ID = 'proj-123';

  it('connects to the project-wide WebSocket endpoint without sessionId', () => {
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    expect(globalThis.WebSocket).toHaveBeenCalledWith(
      expect.stringContaining(`/api/projects/${PROJECT_ID}/sessions/ws`),
    );
    // Should NOT have sessionId param
    expect(mockWs.url).not.toContain('sessionId');
  });

  it('transitions to connected state on open', () => {
    const { result } = renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    expect(result.current.connectionState).toBe('connecting');

    act(() => simulateOpen());
    expect(result.current.connectionState).toBe('connected');
  });

  it('calls onSessionChange (debounced) when a session lifecycle event arrives', () => {
    const onSessionChange = vi.fn();
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange }),
    );

    act(() => simulateOpen());

    // Send a session.created event
    act(() => simulateMessage({ type: 'session.created', payload: { id: 'sess-1' } }));

    // Should not fire immediately (debounced)
    expect(onSessionChange).not.toHaveBeenCalled();

    // Advance past debounce period
    act(() => vi.advanceTimersByTime(600));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
  });

  it('debounces multiple rapid events into a single callback', () => {
    const onSessionChange = vi.fn();
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange }),
    );

    act(() => simulateOpen());

    // Rapid-fire events
    act(() => {
      simulateMessage({ type: 'session.created', payload: { id: 'sess-1' } });
      simulateMessage({ type: 'session.stopped', payload: { sessionId: 'sess-2' } });
      simulateMessage({ type: 'session.updated', payload: { sessionId: 'sess-3' } });
    });

    act(() => vi.advanceTimersByTime(600));
    // All three events should be debounced into a single call
    expect(onSessionChange).toHaveBeenCalledTimes(1);
  });

  it('ignores non-lifecycle events like message.new', () => {
    const onSessionChange = vi.fn();
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange }),
    );

    act(() => simulateOpen());

    act(() => simulateMessage({ type: 'message.new', payload: { content: 'hello' } }));

    act(() => vi.advanceTimersByTime(600));
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('handles session.agent_completed as a lifecycle event', () => {
    const onSessionChange = vi.fn();
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange }),
    );

    act(() => simulateOpen());

    act(() =>
      simulateMessage({
        type: 'session.agent_completed',
        payload: { sessionId: 'sess-1', agentCompletedAt: Date.now() },
      }),
    );

    act(() => vi.advanceTimersByTime(600));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
  });

  it('reconnects with exponential backoff on abnormal close', () => {
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    act(() => simulateOpen());

    // Initial connection
    expect(globalThis.WebSocket).toHaveBeenCalledTimes(1);

    // Abnormal close
    act(() => simulateClose(1006));

    // Advance past first reconnect delay (1s)
    act(() => vi.advanceTimersByTime(1100));
    expect(globalThis.WebSocket).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect on normal close (code 1000)', () => {
    const { result } = renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    act(() => simulateOpen());
    act(() => simulateClose(1000));

    expect(result.current.connectionState).toBe('disconnected');

    act(() => vi.advanceTimersByTime(5000));
    // Should not reconnect
    expect(globalThis.WebSocket).toHaveBeenCalledTimes(1);
  });

  it('sends ping messages to keep connection alive', () => {
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    act(() => simulateOpen());

    // Advance past ping interval (30s)
    act(() => vi.advanceTimersByTime(30100));
    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
  });

  it('cleans up WebSocket on unmount', () => {
    const { unmount } = renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    act(() => simulateOpen());

    unmount();
    expect(mockWs.close).toHaveBeenCalledWith(1000);
  });
});
