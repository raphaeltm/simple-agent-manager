import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAcpSession } from './useAcpSession';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  private listeners: Record<string, Array<(event: Event) => void>> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type]!.push(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners[type];
    if (!list) {
      return;
    }
    this.listeners[type] = list.filter((item) => item !== listener);
  }

  send = vi.fn();

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', new CloseEvent('close'));
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', new Event('open'));
  }

  emitMessage(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('message', new MessageEvent('message', { data }));
  }

  /** Simulate the server sending session_state with idle status (no agent selected). */
  emitIdleSessionState(): void {
    this.emitMessage({
      type: 'session_state',
      status: 'idle',
      agentType: '',
      replayCount: 0,
    });
  }

  /** Open and immediately send idle session_state (common test helper). */
  emitOpenAndIdle(): void {
    this.emitOpen();
    this.emitIdleSessionState();
  }

  private emit(type: string, event: Event): void {
    const list = this.listeners[type] || [];
    for (const listener of list) {
      listener(event);
    }
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAcpSession session_state handling', () => {
  it('stays in connecting state after WS open until session_state arrives', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpen());

    // Should stay in connecting — no session_state yet
    expect(result.current.state).toBe('connecting');

    // Now send idle session_state
    act(() => ws.emitIdleSessionState());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });
  });
});

describe('useAcpSession gateway error handling', () => {

  it('transitions to error state when VM agent sends a gateway error payload', async () => {
    const onAcpMessage = vi.fn();
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
      onAcpMessage,
    }));

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error('expected mock websocket instance');
    }

    act(() => {
      ws.emitOpenAndIdle();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    act(() => {
      ws.emitMessage({
        error: 'session_not_found',
        message: 'Requested session does not exist in this workspace',
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });

    expect(result.current.error).toBe('Requested session does not exist in this workspace');
    expect(onAcpMessage).not.toHaveBeenCalled();
  });

  it('continues forwarding ACP JSON-RPC payloads to onAcpMessage', async () => {
    const onAcpMessage = vi.fn();
    renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
      onAcpMessage,
    }));

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error('expected mock websocket instance');
    }

    act(() => {
      ws.emitOpenAndIdle();
      ws.emitMessage({ jsonrpc: '2.0', method: 'session/update', params: { ok: true } });
    });

    await waitFor(() => {
      expect(onAcpMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe('useAcpSession visibilitychange reconnection', () => {
  it('reconnects immediately when tab becomes visible after WebSocket was dropped', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    // First connection opens
    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Simulate mobile background — WebSocket closes unexpectedly
    act(() => ws1.close());

    // Simulate tab becoming visible again
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // A new WebSocket should have been created (reconnection attempt)
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });

  it('does not reconnect when tab becomes visible but WebSocket is still open', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    const instanceCountBefore = MockWebSocket.instances.length;

    // Simulate tab becoming visible while still connected
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // No new WebSocket should be created
    expect(MockWebSocket.instances.length).toBe(instanceCountBefore);
  });
});

describe('useAcpSession onPrepareForReplay callback', () => {
  it('calls onPrepareForReplay synchronously when session_state has replayCount > 0', async () => {
    const onPrepareForReplay = vi.fn();
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
      onPrepareForReplay,
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.emitOpen();
      ws.emitMessage({
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: 5,
      });
    });

    expect(onPrepareForReplay).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(result.current.state).toBe('replaying');
      expect(result.current.replaying).toBe(true);
    });
  });

  it('does NOT call onPrepareForReplay when replayCount is 0', async () => {
    const onPrepareForReplay = vi.fn();
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
      onPrepareForReplay,
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.emitOpen();
      ws.emitMessage({
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: 0,
      });
    });

    expect(onPrepareForReplay).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
    });
  });
});

describe('useAcpSession prompt state restoration after replay', () => {
  it('transitions to prompting after replay when server status was prompting', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;

    // Server reports status=prompting with replay messages
    act(() => {
      ws.emitOpen();
      ws.emitMessage({
        type: 'session_state',
        status: 'prompting',
        agentType: 'claude-code',
        replayCount: 3,
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('replaying');
    });

    // Simulate replay messages (just ACP JSON-RPC, not tested here)
    // Then replay_complete arrives
    act(() => {
      ws.emitMessage({ type: 'session_replay_complete' });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('prompting');
      expect(result.current.replaying).toBe(false);
    });
  });

  it('transitions to ready after replay when server status was ready', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;

    act(() => {
      ws.emitOpen();
      ws.emitMessage({
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: 2,
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('replaying');
    });

    act(() => {
      ws.emitMessage({ type: 'session_replay_complete' });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
      expect(result.current.replaying).toBe(false);
    });
  });

  it('enters prompting directly when server reports prompting with no replay', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;

    act(() => {
      ws.emitOpen();
      ws.emitMessage({
        type: 'session_state',
        status: 'prompting',
        agentType: 'claude-code',
        replayCount: 0,
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('prompting');
      expect(result.current.replaying).toBe(false);
    });
  });
});

describe('useAcpSession replay prompt-done race handling', () => {
  it('ends replay in ready when session_prompt_done arrives during replay', async () => {
    const { result } = renderHook(() =>
      useAcpSession({
        wsUrl: 'ws://localhost/agent/ws',
      })
    );

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.emitOpen();
      ws.emitMessage({
        type: 'session_state',
        status: 'prompting',
        agentType: 'claude-code',
        replayCount: 2,
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('replaying');
    });

    act(() => {
      ws.emitMessage({ type: 'session_prompt_done' });
      ws.emitMessage({ type: 'session_replay_complete' });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
      expect(result.current.replaying).toBe(false);
    });
  });
});

describe('useAcpSession agentType reset on reconnect', () => {
  it('clears agentType to null when WebSocket opens (Phase 1 hang fix)', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    // First connection — receive session_state then agent_status
    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Simulate receiving agent_status (setting agentType to 'claude-code')
    act(() => {
      ws1.emitMessage({
        type: 'agent_status',
        status: 'ready',
        agentType: 'claude-code',
      });
    });

    await waitFor(() => {
      expect(result.current.agentType).toBe('claude-code');
    });

    // Simulate WebSocket close (mobile background)
    act(() => ws1.close());

    // Simulate visibilitychange reconnect
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // New WebSocket should be created
    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    expect(ws2).not.toBe(ws1);

    // When new WebSocket opens, state goes to connecting; session_state will set no_session
    act(() => ws2.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // agentType should be null/empty after reconnection (not stale 'claude-code')
    // session_state with idle status and empty agentType clears it
    expect(result.current.agentType).toBeNull();
  });

  it('clears error state when WebSocket opens', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpenAndIdle());

    // Simulate an error
    act(() => {
      ws1.emitMessage({
        type: 'agent_status',
        status: 'error',
        agentType: 'claude-code',
        error: 'Something went wrong',
      });
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Something went wrong');
    });

    // Close and trigger reconnect
    act(() => ws1.close());

    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    act(() => ws2.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Error should be cleared
    expect(result.current.error).toBeNull();
  });
});

describe('useAcpSession manual reconnect', () => {
  it('exposes a reconnect function that creates a new connection', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    // First connection opens then closes
    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Force an error state by closing and timing out
    act(() => ws1.close());

    const instanceCountBefore = MockWebSocket.instances.length;

    // Trigger manual reconnect
    act(() => {
      result.current.reconnect();
    });

    // A new WebSocket should have been created
    expect(MockWebSocket.instances.length).toBeGreaterThan(instanceCountBefore);
    expect(result.current.state).toBe('reconnecting');
  });

  it('does not create duplicate connections when already connected', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    const instanceCountBefore = MockWebSocket.instances.length;

    // Try to reconnect while already connected — should be a no-op
    act(() => {
      result.current.reconnect();
    });

    expect(MockWebSocket.instances.length).toBe(instanceCountBefore);
  });
});

describe('useAcpSession resolver-driven URL refresh', () => {
  it('uses resolveWsUrl on initial connect and manual reconnect', async () => {
    const resolveWsUrl = vi
      .fn()
      .mockResolvedValueOnce('ws://localhost/agent/ws?token=first')
      .mockResolvedValueOnce('ws://localhost/agent/ws?token=second');

    const { result } = renderHook(() =>
      useAcpSession({
        wsUrl: null,
        resolveWsUrl,
      })
    );

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    expect(MockWebSocket.instances[0]?.url).toContain('token=first');

    act(() => {
      MockWebSocket.instances[0]?.emitOpenAndIdle();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    act(() => {
      MockWebSocket.instances[0]?.close();
      result.current.reconnect();
    });

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(2);
    });
    expect(MockWebSocket.instances[1]?.url).toContain('token=second');
    expect(resolveWsUrl).toHaveBeenCalledTimes(2);
  });
});
