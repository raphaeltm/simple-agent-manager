import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatWebSocket } from '../../../src/hooks/useChatWebSocket';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sent: string[] = [];
  private _closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    if (this._closed) return;
    this._closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  simulateAbnormalClose(code = 1006) {
    this._closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

// ---------------------------------------------------------------------------
// Mock getChatSession (used by catch-up)
// ---------------------------------------------------------------------------
vi.mock('../../../src/lib/api', () => ({
  getChatSession: vi.fn().mockResolvedValue({
    session: { id: 'sess-1', status: 'running' },
    messages: [],
    hasMore: false,
  }),
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function defaultOpts() {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    enabled: true,
    onMessage: vi.fn(),
    onSessionStopped: vi.fn(),
    onCatchUp: vi.fn(),
    onAgentCompleted: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Render the hook and open the socket. */
function renderAndOpen(opts = defaultOpts()) {
  const hookReturn = renderHook(() => useChatWebSocket(opts));
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  act(() => ws.simulateOpen());
  return { ...hookReturn, ws, opts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChatWebSocket', () => {
  describe('connection lifecycle', () => {
    it('creates a WebSocket and transitions to connected on open', () => {
      const { result, ws } = renderAndOpen();
      expect(ws).toBeDefined();
      expect(ws.url).toContain('/sessions/ws');
      expect(result.current.connectionState).toBe('connected');
    });

    it('transitions to disconnected on normal close (1000)', () => {
      const { result, ws } = renderAndOpen();
      act(() => ws.close(1000));
      expect(result.current.connectionState).toBe('disconnected');
    });

    it('transitions to reconnecting on abnormal close', () => {
      const { result, ws } = renderAndOpen();
      act(() => ws.simulateAbnormalClose(1006));
      expect(result.current.connectionState).toBe('reconnecting');
    });

    it('does not connect when disabled', () => {
      const opts = defaultOpts();
      opts.enabled = false;
      renderHook(() => useChatWebSocket(opts));
      expect(MockWebSocket.instances).toHaveLength(0);
    });
  });

  describe('ping/pong heartbeat', () => {
    it('sends a JSON ping every 30 seconds', () => {
      const { ws } = renderAndOpen();
      expect(ws.sent).toHaveLength(0);

      act(() => vi.advanceTimersByTime(30_000));
      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0])).toEqual({ type: 'ping' });

      // Send pong to keep connection alive (otherwise pong timeout closes it)
      act(() => ws.simulateMessage({ type: 'pong' }));

      act(() => vi.advanceTimersByTime(30_000));
      expect(ws.sent).toHaveLength(2);
    });

    it('force-closes the WebSocket if no pong arrives within 10s of a ping', () => {
      const { ws } = renderAndOpen();

      // Trigger first ping
      act(() => vi.advanceTimersByTime(30_000));
      expect(ws.sent).toHaveLength(1);
      expect(ws.readyState).toBe(MockWebSocket.OPEN);

      // Advance 10s without pong — timeout should fire and close with code 4000
      act(() => vi.advanceTimersByTime(10_000));
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('clears the pong timeout when a pong message is received', () => {
      const { ws } = renderAndOpen();

      // Trigger first ping
      act(() => vi.advanceTimersByTime(30_000));
      expect(ws.sent).toHaveLength(1);

      // Receive pong before timeout
      act(() => ws.simulateMessage({ type: 'pong' }));

      // Advance well past the timeout window — socket should still be open
      act(() => vi.advanceTimersByTime(15_000));
      expect(ws.readyState).toBe(MockWebSocket.OPEN);
    });

    it('resets the pong timeout on each new ping', () => {
      const { ws } = renderAndOpen();

      // First ping at 30s
      act(() => vi.advanceTimersByTime(30_000));
      // Receive pong
      act(() => ws.simulateMessage({ type: 'pong' }));

      // Second ping at 60s
      act(() => vi.advanceTimersByTime(30_000));
      expect(ws.sent).toHaveLength(2);

      // 10s after second ping without pong — should close
      act(() => vi.advanceTimersByTime(10_000));
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('cleans up timers on unmount', () => {
      const { unmount } = renderAndOpen();

      // Trigger a ping (starts pong timeout)
      act(() => vi.advanceTimersByTime(30_000));

      // Unmount the hook
      unmount();

      // Advancing time should not throw or cause state updates
      expect(() => act(() => vi.advanceTimersByTime(60_000))).not.toThrow();
    });
  });

  describe('message handling', () => {
    it('delivers message.new via onMessage callback', () => {
      const { ws, opts } = renderAndOpen();

      act(() =>
        ws.simulateMessage({
          type: 'message.new',
          payload: {
            sessionId: 'sess-1',
            role: 'assistant',
            content: 'Hello world',
            messageId: 'msg-1',
            createdAt: 1000,
          },
        })
      );

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          content: 'Hello world',
          sessionId: 'sess-1',
        })
      );
    });

    it('delivers messages.batch items individually', () => {
      const { ws, opts } = renderAndOpen();

      act(() =>
        ws.simulateMessage({
          type: 'messages.batch',
          payload: {
            sessionId: 'sess-1',
            messages: [
              { id: 'm1', role: 'assistant', content: 'First', createdAt: 1 },
              { id: 'm2', role: 'assistant', content: 'Second', createdAt: 2 },
            ],
          },
        })
      );

      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });

    it('ignores messages for other sessions', () => {
      const { ws, opts } = renderAndOpen();

      act(() =>
        ws.simulateMessage({
          type: 'message.new',
          payload: {
            sessionId: 'other-session',
            role: 'assistant',
            content: 'Should be ignored',
          },
        })
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('calls onSessionStopped for session.stopped', () => {
      const { ws, opts } = renderAndOpen();

      act(() =>
        ws.simulateMessage({
          type: 'session.stopped',
          payload: { sessionId: 'sess-1' },
        })
      );

      expect(opts.onSessionStopped).toHaveBeenCalledTimes(1);
    });

    it('calls onAgentCompleted for session.agent_completed', () => {
      const { ws, opts } = renderAndOpen();

      act(() =>
        ws.simulateMessage({
          type: 'session.agent_completed',
          payload: { sessionId: 'sess-1', agentCompletedAt: 12345 },
        })
      );

      expect(opts.onAgentCompleted).toHaveBeenCalledWith(12345);
    });

    it('pong messages do not trigger onMessage', () => {
      const { ws, opts } = renderAndOpen();

      act(() => ws.simulateMessage({ type: 'pong' }));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onSessionStopped).not.toHaveBeenCalled();
    });
  });

  describe('reconnection', () => {
    it('uses exponential backoff starting at 1s', () => {
      const { ws: ws1 } = renderAndOpen();

      // Abnormal close
      act(() => ws1.simulateAbnormalClose(1006));

      const countBefore = MockWebSocket.instances.length;
      // After 1s, first retry should fire
      act(() => vi.advanceTimersByTime(1000));
      expect(MockWebSocket.instances.length).toBe(countBefore + 1);
    });

    it('second retry waits 2s (exponential)', () => {
      const { ws: ws1 } = renderAndOpen();

      // First abnormal close → reconnecting
      act(() => ws1.simulateAbnormalClose(1006));
      // First retry after 1s
      act(() => vi.advanceTimersByTime(1000));
      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];

      // Second abnormal close
      act(() => ws2.simulateAbnormalClose(1006));

      const countBefore = MockWebSocket.instances.length;
      // Should NOT reconnect after 1s
      act(() => vi.advanceTimersByTime(1000));
      expect(MockWebSocket.instances.length).toBe(countBefore);

      // Should reconnect after 2s total
      act(() => vi.advanceTimersByTime(1000));
      expect(MockWebSocket.instances.length).toBe(countBefore + 1);
    });

    it('retry() resets retries and reconnects immediately', () => {
      const { result, ws: ws1 } = renderAndOpen();

      // Abnormal close
      act(() => ws1.simulateAbnormalClose(1006));
      expect(result.current.connectionState).toBe('reconnecting');

      // Manual retry
      const countBefore = MockWebSocket.instances.length;
      act(() => result.current.retry());
      expect(MockWebSocket.instances.length).toBe(countBefore + 1);
    });
  });
});
