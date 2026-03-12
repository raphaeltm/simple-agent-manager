import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatWebSocket } from '../../../src/hooks/useChatWebSocket';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSEventHandler = ((event: unknown) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: WSEventHandler = null;
  onmessage: WSEventHandler = null;
  onclose: WSEventHandler = null;
  onerror: WSEventHandler = null;
  sentMessages: string[] = [];
  closeCode?: number;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(code?: number) {
    this.closeCode = code;
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

// Mock getChatSession for catch-up
vi.mock('../../../src/lib/api', () => ({
  getChatSession: vi.fn().mockResolvedValue({
    session: { id: 'sess-1', status: 'active', workspaceId: null, topic: null, messageCount: 0, startedAt: 0, endedAt: null, createdAt: 0 },
    messages: [{ id: 'msg-catchup-1', sessionId: 'sess-1', role: 'assistant', content: 'caught up', toolMetadata: null, createdAt: 100 }],
    hasMore: false,
  }),
}));

const defaultProps = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  enabled: true,
  onMessage: vi.fn(),
  onSessionStopped: vi.fn(),
  onCatchUp: vi.fn(),
};

describe('useChatWebSocket (behavioral)', () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    // @ts-expect-error -- mock class
    globalThis.WebSocket = MockWebSocket;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('creates a WebSocket connection when enabled', () => {
    renderHook(() => useChatWebSocket({ ...defaultProps }));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.url).toContain('/api/projects/proj-1/sessions/ws');
    // Session-scoped server-side filtering: sessionId must be in WS URL query params
    expect(MockWebSocket.instances[0]!.url).toContain('sessionId=');
  });

  it('does not create WebSocket when disabled', () => {
    renderHook(() => useChatWebSocket({ ...defaultProps, enabled: false }));

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('transitions to connected state on open', () => {
    const { result } = renderHook(() => useChatWebSocket({ ...defaultProps }));

    expect(result.current.connectionState).toBe('connecting');

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    expect(result.current.connectionState).toBe('connected');
  });

  it('calls onMessage when a message.new event arrives', () => {
    const onMessage = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onMessage }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'message.new',
        sessionId: 'sess-1',
        id: 'msg-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: Date.now(),
      });
    });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'msg-1',
      role: 'assistant',
      content: 'Hello',
    }));
  });

  it('ignores messages for different sessions', () => {
    const onMessage = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onMessage }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'message.new',
        sessionId: 'sess-other',
        id: 'msg-1',
        role: 'assistant',
        content: 'Wrong session',
      });
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('calls onSessionStopped on session.stopped event', () => {
    const onSessionStopped = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onSessionStopped }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'session.stopped',
        sessionId: 'sess-1',
      });
    });

    expect(onSessionStopped).toHaveBeenCalledOnce();
  });

  it('reconnects with exponential backoff on abnormal close', () => {
    renderHook(() => useChatWebSocket({ ...defaultProps }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    // Abnormal close — should schedule reconnect after 1000ms
    act(() => {
      MockWebSocket.instances[0]!.simulateClose(1006);
    });

    const countAfterClose = MockWebSocket.instances.length;

    // Not yet at 999ms
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(MockWebSocket.instances.length).toBe(countAfterClose);

    // At 1000ms, reconnect fires
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockWebSocket.instances.length).toBe(countAfterClose + 1);
  });

  it('does not reconnect on normal close (code 1000)', () => {
    const { result } = renderHook(() => useChatWebSocket({ ...defaultProps }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateClose(1000);
    });

    expect(result.current.connectionState).toBe('disconnected');
    const countAfterClose = MockWebSocket.instances.length;

    // Wait — no reconnect should happen
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockWebSocket.instances.length).toBe(countAfterClose);
  });

  it('gives up after MAX_RETRIES (10)', () => {
    const { result } = renderHook(() => useChatWebSocket({ ...defaultProps }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    // Exhaust all 10 retries
    for (let i = 0; i < 10; i++) {
      const lastIdx = MockWebSocket.instances.length - 1;
      act(() => {
        MockWebSocket.instances[lastIdx]!.simulateClose(1006);
      });
      act(() => {
        vi.advanceTimersByTime(31000); // Well past max delay
      });
    }

    // 11th close — should give up
    const lastIdx = MockWebSocket.instances.length - 1;
    act(() => {
      MockWebSocket.instances[lastIdx]!.simulateClose(1006);
    });

    expect(result.current.connectionState).toBe('disconnected');

    // No more reconnects
    const countBefore = MockWebSocket.instances.length;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockWebSocket.instances.length).toBe(countBefore);
  });

  it('fetches missed messages on reconnect', async () => {
    const onCatchUp = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onCatchUp }));

    // First connect — catch-up fires (always catches up now)
    await act(async () => {
      MockWebSocket.instances[0]!.simulateOpen();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCatchUp).toHaveBeenCalledTimes(1);

    // Disconnect
    act(() => {
      MockWebSocket.instances[0]!.simulateClose(1006);
    });

    // Advance past backoff
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Reconnect — should trigger catch-up again
    await act(async () => {
      MockWebSocket.instances[1]!.simulateOpen();
      // Flush the getChatSession promise
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCatchUp).toHaveBeenCalledTimes(2);
    expect(onCatchUp).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'msg-catchup-1' })]),
      expect.any(Object),
      false,
    );
  });

  it('stale onclose does not null the new active socket (BUG-2 fix)', () => {
    const { result } = renderHook(() => useChatWebSocket({ ...defaultProps }));

    const firstWs = MockWebSocket.instances[0]!;
    act(() => {
      firstWs.simulateOpen();
    });

    // Force a new connection via retry (closes old socket with 1000,
    // then creates a new one)
    act(() => {
      result.current.retry();
    });

    const secondWs = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    act(() => {
      secondWs.simulateOpen();
    });

    expect(result.current.connectionState).toBe('connected');

    // Now simulate the OLD socket's onclose firing late (stale event)
    act(() => {
      firstWs.onclose?.({ code: 1006 });
    });

    // Should NOT affect the state — guard prevents it
    expect(result.current.connectionState).toBe('connected');
    expect(result.current.wsRef.current).toBe(secondWs);
  });

  it('cleans up socket on unmount', () => {
    const { unmount } = renderHook(() => useChatWebSocket({ ...defaultProps }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    const ws = MockWebSocket.instances[0]!;
    unmount();

    expect(ws.closeCode).toBe(1000);
  });

  it('retry resets state and reconnects', () => {
    const { result } = renderHook(() => useChatWebSocket({ ...defaultProps }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
      MockWebSocket.instances[0]!.simulateClose(1006);
    });

    // Retry
    act(() => {
      result.current.retry();
    });

    const newWs = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    act(() => {
      newWs.simulateOpen();
    });

    expect(result.current.connectionState).toBe('connected');
  });

  it('retry triggers message catch-up (CodeRabbit fix)', async () => {
    const onCatchUp = vi.fn();
    const { result } = renderHook(() => useChatWebSocket({ ...defaultProps, onCatchUp }));

    // First connect — catch-up fires (always catches up now)
    await act(async () => {
      MockWebSocket.instances[0]!.simulateOpen();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCatchUp).toHaveBeenCalledTimes(1);

    // Disconnect
    act(() => {
      MockWebSocket.instances[0]!.simulateClose(1006);
    });

    // Retry (manual) — should trigger catch-up again
    act(() => {
      result.current.retry();
    });

    await act(async () => {
      MockWebSocket.instances[MockWebSocket.instances.length - 1]!.simulateOpen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCatchUp).toHaveBeenCalledTimes(2);
  });

  it('sends ping every 30 seconds when connected', () => {
    renderHook(() => useChatWebSocket({ ...defaultProps }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    const ws = MockWebSocket.instances[0]!;
    expect(ws.sentMessages).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0]!)).toEqual({ type: 'ping' });
  });

  it('does not send ping when socket is not open', () => {
    renderHook(() => useChatWebSocket({ ...defaultProps }));

    // Socket is CONNECTING (readyState = 0), not OPEN
    const ws = MockWebSocket.instances[0]!;
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(ws.sentMessages).toHaveLength(0);
  });

  it('disconnects when enabled changes to false', () => {
    const { result, rerender } = renderHook(
      (props) => useChatWebSocket(props),
      { initialProps: { ...defaultProps, enabled: true } },
    );

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });
    expect(result.current.connectionState).toBe('connected');

    rerender({ ...defaultProps, enabled: false });

    expect(result.current.connectionState).toBe('disconnected');
  });

  it('ignores malformed messages gracefully', () => {
    const onMessage = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onMessage }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    // Send invalid JSON — should not throw
    act(() => {
      MockWebSocket.instances[0]!.onmessage?.({ data: 'not json{{{' });
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // messages.batch event handling (TDF message relay fix)
  // ===========================================================================

  it('delivers each message from a messages.batch event via onMessage', () => {
    const onMessage = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onMessage }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'messages.batch',
        payload: {
          sessionId: 'sess-1',
          messages: [
            { id: 'batch-1', role: 'assistant', content: 'Hello', createdAt: 100 },
            { id: 'batch-2', role: 'assistant', content: 'World', createdAt: 200 },
          ],
        },
      });
    });

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'batch-1',
      content: 'Hello',
    }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'batch-2',
      content: 'World',
    }));
  });

  it('skips batch messages without content', () => {
    const onMessage = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onMessage }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'messages.batch',
        payload: {
          sessionId: 'sess-1',
          messages: [
            { id: 'batch-1', role: 'assistant', content: 'Has content', createdAt: 100 },
            { id: 'batch-2', role: 'assistant', createdAt: 200 }, // no content
            { id: 'batch-3', role: 'assistant', content: '', createdAt: 300 }, // empty content
          ],
        },
      });
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'batch-1',
      content: 'Has content',
    }));
  });

  it('ignores messages.batch for different sessions', () => {
    const onMessage = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onMessage }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'messages.batch',
        payload: {
          sessionId: 'sess-other',
          messages: [
            { id: 'batch-1', role: 'assistant', content: 'Wrong session', createdAt: 100 },
          ],
        },
      });
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // session.agent_completed event (TDF message relay fix)
  // ===========================================================================

  it('calls onAgentCompleted on session.agent_completed event', () => {
    const onAgentCompleted = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onAgentCompleted }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'session.agent_completed',
        payload: {
          sessionId: 'sess-1',
          agentCompletedAt: 1234567890,
        },
      });
    });

    expect(onAgentCompleted).toHaveBeenCalledOnce();
    expect(onAgentCompleted).toHaveBeenCalledWith(1234567890);
  });

  it('ignores session.agent_completed for different sessions', () => {
    const onAgentCompleted = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onAgentCompleted }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'session.agent_completed',
        payload: {
          sessionId: 'sess-other',
          agentCompletedAt: 1234567890,
        },
      });
    });

    expect(onAgentCompleted).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // message.new with payload wrapper (broadcast format, TDF fix)
  // ===========================================================================

  it('handles message.new with payload wrapper from broadcast', () => {
    const onMessage = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onMessage }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'message.new',
        payload: {
          sessionId: 'sess-1',
          messageId: 'msg-wrapped',
          role: 'assistant',
          content: 'Wrapped message',
          createdAt: 12345,
        },
      });
    });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'msg-wrapped',
      role: 'assistant',
      content: 'Wrapped message',
      createdAt: 12345,
    }));
  });

  it('skips message.new without content', () => {
    const onMessage = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onMessage }));

    act(() => {
      MockWebSocket.instances[0]!.simulateOpen();
    });

    act(() => {
      MockWebSocket.instances[0]!.simulateMessage({
        type: 'message.new',
        sessionId: 'sess-1',
        id: 'msg-no-content',
        role: 'assistant',
        // No content field — should be skipped
      });
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Catch-up on first connect (TDF fix — not just reconnects)
  // ===========================================================================

  it('triggers catch-up on first connect (not just reconnect)', async () => {
    const onCatchUp = vi.fn();
    renderHook(() => useChatWebSocket({ ...defaultProps, onCatchUp }));

    // First connect — catch-up should fire now (changed behavior)
    await act(async () => {
      MockWebSocket.instances[0]!.simulateOpen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCatchUp).toHaveBeenCalledOnce();
    expect(onCatchUp).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'msg-catchup-1' })]),
      expect.any(Object),
      false,
    );
  });
});
