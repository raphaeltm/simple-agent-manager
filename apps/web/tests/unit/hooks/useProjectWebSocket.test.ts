import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProjectWebSocket } from '../../../src/hooks/useProjectWebSocket';

// ---------------------------------------------------------------------------
// WebSocket mock — supports tracking multiple instances
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

function createMockWs(): MockWebSocket {
  return {
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    readyState: 0, // CONNECTING
    close: vi.fn(),
    send: vi.fn(),
    url: '',
  };
}

/** All WebSocket instances created during a test, in order. */
let wsInstances: MockWebSocket[];
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  wsInstances = [];

  globalThis.WebSocket = vi.fn((url: string) => {
    const ws = createMockWs();
    ws.url = url;
    wsInstances.push(ws);
    return ws;
  }) as unknown as typeof WebSocket;

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

/** Get the most recently created WebSocket mock. */
function latestWs(): MockWebSocket {
  return wsInstances[wsInstances.length - 1]!;
}

function simulateOpen(ws?: MockWebSocket) {
  const target = ws ?? latestWs();
  target.readyState = 1; // OPEN
  target.onopen?.(new Event('open'));
}

function simulateMessage(data: Record<string, unknown>, ws?: MockWebSocket) {
  const target = ws ?? latestWs();
  target.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
}

function simulateClose(code = 1006, ws?: MockWebSocket) {
  const target = ws ?? latestWs();
  target.readyState = 3; // CLOSED
  target.onclose?.({ code } as CloseEvent);
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
    expect(latestWs().url).not.toContain('sessionId');
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

    act(() => {
      simulateMessage({ type: 'session.created', payload: { id: 'sess-1' } });
      simulateMessage({ type: 'session.stopped', payload: { sessionId: 'sess-2' } });
      simulateMessage({ type: 'session.updated', payload: { sessionId: 'sess-3' } });
    });

    act(() => vi.advanceTimersByTime(600));
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
    expect(wsInstances).toHaveLength(1);

    act(() => simulateClose(1006));

    // Advance past first reconnect delay (1s)
    act(() => vi.advanceTimersByTime(1100));
    expect(wsInstances).toHaveLength(2);
  });

  it('does not reconnect on normal close (code 1000)', () => {
    const { result } = renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    act(() => simulateOpen());
    act(() => simulateClose(1000));

    expect(result.current.connectionState).toBe('disconnected');

    act(() => vi.advanceTimersByTime(5000));
    expect(wsInstances).toHaveLength(1);
  });

  it('sends ping messages to keep connection alive', () => {
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    act(() => simulateOpen());

    act(() => vi.advanceTimersByTime(30100));
    expect(latestWs().send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
  });

  it('does not send ping when socket is not open', () => {
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    // Socket stays in CONNECTING state (readyState = 0), don't call simulateOpen()

    act(() => vi.advanceTimersByTime(30100));
    expect(latestWs().send).not.toHaveBeenCalled();
  });

  it('cleans up WebSocket on unmount', () => {
    const { unmount } = renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    act(() => simulateOpen());

    unmount();
    expect(latestWs().close).toHaveBeenCalledWith(1000);
  });

  it('ignores events from a stale (superseded) socket after reconnect', () => {
    const onSessionChange = vi.fn();
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange }),
    );

    act(() => simulateOpen());
    const oldWs = latestWs();

    // Abnormal close triggers reconnect
    act(() => simulateClose(1006, oldWs));
    act(() => vi.advanceTimersByTime(1100));

    // New socket is created
    expect(wsInstances).toHaveLength(2);
    const newWs = latestWs();
    act(() => simulateOpen(newWs));

    // Event on the OLD socket should be ignored
    act(() => simulateMessage({ type: 'session.created', payload: { id: 'sess-1' } }, oldWs));
    act(() => vi.advanceTimersByTime(600));
    expect(onSessionChange).not.toHaveBeenCalled();

    // Event on the NEW socket should work
    act(() => simulateMessage({ type: 'session.created', payload: { id: 'sess-2' } }, newWs));
    act(() => vi.advanceTimersByTime(600));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
  });

  it('reconnects to the new project URL when projectId changes', () => {
    const { rerender } = renderHook(
      ({ projectId }) =>
        useProjectWebSocket({ projectId, onSessionChange: vi.fn() }),
      { initialProps: { projectId: 'proj-A' } },
    );

    act(() => simulateOpen());
    const firstWs = latestWs();
    expect(firstWs.url).toContain('proj-A');

    // Change projectId
    rerender({ projectId: 'proj-B' });

    // Old socket should be closed
    expect(firstWs.close).toHaveBeenCalledWith(1000);

    // New socket should connect to the new project
    expect(wsInstances).toHaveLength(2);
    expect(latestWs().url).toContain('proj-B');
  });

  it('stops reconnecting after max retries are exhausted', () => {
    const { result } = renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange: vi.fn() }),
    );

    // Don't call simulateOpen — immediately close each new socket to simulate
    // repeated connection failures. Each close fires on the latest instance.
    for (let i = 0; i < 10; i++) {
      act(() => simulateClose(1006));
      const delay = Math.min(1000 * Math.pow(2, i), 30000);
      act(() => vi.advanceTimersByTime(delay + 100));
    }

    // The 11th scheduleReconnect sees retriesRef >= MAX_RETRIES and gives up
    act(() => simulateClose(1006));

    expect(result.current.connectionState).toBe('disconnected');

    const totalConnections = wsInstances.length;

    // Advance much further — no more reconnects should happen
    act(() => vi.advanceTimersByTime(60000));
    expect(wsInstances).toHaveLength(totalConnections);
  });

  it('ignores malformed (non-JSON) messages without error', () => {
    const onSessionChange = vi.fn();
    renderHook(() =>
      useProjectWebSocket({ projectId: PROJECT_ID, onSessionChange }),
    );

    act(() => simulateOpen());

    // Send raw non-JSON string
    act(() => {
      latestWs().onmessage?.(new MessageEvent('message', { data: 'not-json' }));
    });

    act(() => vi.advanceTimersByTime(600));
    expect(onSessionChange).not.toHaveBeenCalled();
  });
});
