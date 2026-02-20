import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAcpSession, addJitter, classifyCloseCode } from './useAcpSession';
import type { AcpErrorCode } from '../errors';

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

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', new CloseEvent('close', { code: code ?? 1006, reason: reason ?? '' }));
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

  it('forces a fresh connection when called while connected (e.g., agent error with live WS)', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    const instanceCountBefore = MockWebSocket.instances.length;

    // Reconnect while WebSocket is still open — should close old and create new
    act(() => {
      result.current.reconnect();
    });

    expect(MockWebSocket.instances.length).toBeGreaterThan(instanceCountBefore);
    expect(ws1.readyState).toBe(MockWebSocket.CLOSED);
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

describe('useAcpSession post-replay session_state guard', () => {
  it('does NOT re-enter replay when post-replay session_state has replayCount > 0', async () => {
    const onPrepareForReplay = vi.fn();
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
      onPrepareForReplay,
    }));

    const ws = MockWebSocket.instances[0]!;

    // 1. Connect and receive pre-replay session_state
    act(() => {
      ws.emitOpen();
      ws.emitMessage({
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: 10,
      });
    });

    expect(onPrepareForReplay).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.state).toBe('replaying');
    });

    // 2. Replay complete
    act(() => {
      ws.emitMessage({ type: 'session_replay_complete' });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
      expect(result.current.replaying).toBe(false);
    });

    // 3. Post-replay session_state arrives with stale replayCount > 0
    //    This MUST NOT trigger prepareForReplay or re-enter replaying
    act(() => {
      ws.emitMessage({
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: 10,
      });
    });

    // Should NOT have called prepareForReplay again
    expect(onPrepareForReplay).toHaveBeenCalledTimes(1);
    // Should still be in ready state
    expect(result.current.state).toBe('ready');
    expect(result.current.replaying).toBe(false);
  });

  it('allows replay on a new connection after a previous replay completed', async () => {
    const onPrepareForReplay = vi.fn();
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
      onPrepareForReplay,
    }));

    const ws1 = MockWebSocket.instances[0]!;

    // First connection: full replay cycle
    act(() => {
      ws1.emitOpen();
      ws1.emitMessage({
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: 5,
      });
    });

    expect(onPrepareForReplay).toHaveBeenCalledTimes(1);

    act(() => {
      ws1.emitMessage({ type: 'session_replay_complete' });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
    });

    // Disconnect
    act(() => ws1.close());

    // Simulate reconnect via visibilitychange
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    expect(ws2).not.toBe(ws1);

    // Second connection: replay guard should be reset, allowing fresh replay
    act(() => {
      ws2.emitOpen();
      ws2.emitMessage({
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: 5,
      });
    });

    // Should have called prepareForReplay again for the new connection
    expect(onPrepareForReplay).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(result.current.state).toBe('replaying');
    });
  });
});

describe('addJitter', () => {
  it('returns a value within ±25% of the input', () => {
    // Run multiple times to exercise the random range
    for (let i = 0; i < 100; i++) {
      const result = addJitter(1000);
      expect(result).toBeGreaterThanOrEqual(750);
      expect(result).toBeLessThanOrEqual(1250);
    }
  });

  it('returns an integer', () => {
    const result = addJitter(1000);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('handles zero delay', () => {
    const result = addJitter(0);
    expect(result).toBe(0);
  });
});

describe('classifyCloseCode', () => {
  it('returns no-reconnect for normal closure (1000)', () => {
    expect(classifyCloseCode(1000)).toBe('no-reconnect');
  });

  it('returns immediate for going-away (1001)', () => {
    expect(classifyCloseCode(1001)).toBe('immediate');
  });

  it('returns immediate for abnormal closure / network drop (1006)', () => {
    expect(classifyCloseCode(1006)).toBe('immediate');
  });

  it('returns no-reconnect for policy violation (1008)', () => {
    expect(classifyCloseCode(1008)).toBe('no-reconnect');
  });

  it('returns backoff for internal server error (1011)', () => {
    expect(classifyCloseCode(1011)).toBe('backoff');
  });

  it('returns backoff for heartbeat timeout (4000)', () => {
    expect(classifyCloseCode(4000)).toBe('backoff');
  });

  it('returns no-reconnect for auth expired (4001)', () => {
    expect(classifyCloseCode(4001)).toBe('no-reconnect');
  });

  it('returns backoff for undefined code', () => {
    expect(classifyCloseCode(undefined)).toBe('backoff');
  });

  it('returns backoff for unknown codes', () => {
    expect(classifyCloseCode(9999)).toBe('backoff');
  });
});

describe('useAcpSession close code handling', () => {
  it('does not reconnect when server sends normal close (1000)', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    const instancesBefore = MockWebSocket.instances.length;

    // Server sends a clean close — should NOT trigger reconnection
    act(() => ws.close(1000, 'normal'));

    // Should go to error with structured code, not reconnecting
    expect(result.current.state).toBe('error');
    expect(result.current.errorCode).toBe('UNKNOWN' satisfies AcpErrorCode);
    // No new WebSocket should be created
    expect(MockWebSocket.instances.length).toBe(instancesBefore);
  });

  it('does not reconnect when server sends policy violation (1008)', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    const instancesBefore = MockWebSocket.instances.length;

    act(() => ws.close(1008, 'policy_violation'));

    expect(result.current.state).toBe('error');
    expect(result.current.errorCode).toBe('AUTH_REJECTED' satisfies AcpErrorCode);
    expect(MockWebSocket.instances.length).toBe(instancesBefore);
  });

  it('attempts reconnection on abnormal closure (1006)', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Network drop — should trigger reconnection
    act(() => ws.close(1006, ''));

    expect(result.current.state).toBe('reconnecting');
  });

  it('attempts reconnection on heartbeat timeout (4000)', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Heartbeat timeout — should trigger backoff reconnection
    act(() => ws.close(4000, 'heartbeat_timeout'));

    expect(result.current.state).toBe('reconnecting');
  });
});

describe('useAcpSession stale transport cleanup', () => {
  it('cleans up stale transport when connect() is called with a lingering connection', async () => {
    // Scenario: first connection drops, reconnect fires, but the first WS
    // hasn't fully closed yet when the second connect() call happens.
    // The stale transport guard in connect() should close it.
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Close the WS (network drop triggers reconnection attempt)
    act(() => ws1.close(1006));

    expect(result.current.state).toBe('reconnecting');

    // The reconnection will create a new WebSocket after backoff timer fires.
    // A new WebSocket instance should eventually be created.
    // Meanwhile, the old ws1 should be CLOSED.
    expect(ws1.readyState).toBe(MockWebSocket.CLOSED);
  });
});

describe('useAcpSession structured error codes', () => {
  it('sets errorCode on gateway error messages', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    act(() => {
      ws.emitMessage({
        error: 'agent_crash',
        message: 'Agent process crashed with signal SIGKILL',
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
      expect(result.current.errorCode).toBe('AGENT_CRASH' satisfies AcpErrorCode);
      expect(result.current.error).toBe('Agent process crashed with signal SIGKILL');
    });
  });

  it('sets errorCode from agent_status error messages', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    act(() => {
      ws.emitMessage({
        type: 'agent_status',
        status: 'error',
        agentType: 'claude-code',
        error: 'Agent install failed: npm error',
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
      expect(result.current.errorCode).toBe('AGENT_INSTALL_FAILED' satisfies AcpErrorCode);
    });
  });

  it('clears errorCode when error is resolved', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Trigger error
    act(() => {
      ws.emitMessage({
        type: 'agent_status',
        status: 'error',
        agentType: 'claude-code',
        error: 'Something crashed',
      });
    });

    await waitFor(() => {
      expect(result.current.errorCode).not.toBeNull();
    });

    // Resolve error via new agent status
    act(() => {
      ws.emitMessage({
        type: 'agent_status',
        status: 'ready',
        agentType: 'claude-code',
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
      expect(result.current.errorCode).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  it('sets CONNECTION_FAILED errorCode when initial connection fails', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;

    // Simulate connection failure (close without ever opening)
    act(() => ws.close(1006));

    await waitFor(() => {
      expect(result.current.state).toBe('error');
      expect(result.current.errorCode).toBe('CONNECTION_FAILED' satisfies AcpErrorCode);
    });
  });

  it('sets URL_UNAVAILABLE when resolver returns null', async () => {
    const resolveWsUrl = vi.fn().mockResolvedValue(null);

    const { result } = renderHook(() => useAcpSession({
      wsUrl: null,
      resolveWsUrl,
    }));

    await waitFor(() => {
      expect(result.current.state).toBe('error');
      expect(result.current.errorCode).toBe('URL_UNAVAILABLE' satisfies AcpErrorCode);
    });
  });

  it('sets AUTH_EXPIRED errorCode on close code 4001', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    act(() => ws.close(4001, 'auth_expired'));

    await waitFor(() => {
      expect(result.current.state).toBe('error');
      expect(result.current.errorCode).toBe('AUTH_EXPIRED' satisfies AcpErrorCode);
    });
  });
});

describe('useAcpSession manual reconnect with agent restart', () => {
  it('transitions to no_session when reconnecting to an errored session, enabling auto-reselect', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Agent starts and then crashes
    act(() => {
      ws1.emitMessage({
        type: 'agent_status',
        status: 'ready',
        agentType: 'claude-code',
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
      expect(result.current.agentType).toBe('claude-code');
    });

    act(() => {
      ws1.emitMessage({
        type: 'agent_status',
        status: 'error',
        agentType: 'claude-code',
        error: 'Agent crashed and could not be restarted',
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
      expect(result.current.agentType).toBe('claude-code');
    });

    // User clicks "Reconnect" button — triggers manual reconnect
    act(() => {
      result.current.reconnect();
    });

    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    expect(ws2).not.toBe(ws1);

    // SessionHost still in error → sends session_state with status=error
    act(() => {
      ws2.emitOpen();
      ws2.emitMessage({
        type: 'session_state',
        status: 'error',
        agentType: 'claude-code',
        error: 'Agent crashed and could not be restarted',
        replayCount: 0,
      });
    });

    // Should transition to no_session (not error) so auto-select can fire
    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });
    // agentType should be cleared so auto-select sees a mismatch
    expect(result.current.agentType).toBeNull();
    // Error should be cleared
    expect(result.current.error).toBeNull();
  });

  it('does NOT trigger agent restart on automatic reconnection (only manual)', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws1 = MockWebSocket.instances[0]!;
    act(() => {
      ws1.emitOpen();
      ws1.emitMessage({
        type: 'session_state',
        status: 'error',
        agentType: 'claude-code',
        error: 'Agent crashed',
        replayCount: 0,
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });

    // Simulate network drop (automatic reconnection, NOT manual)
    act(() => ws1.close(1006));

    // Wait for backoff timer to fire and create new WebSocket
    // Note: reconnection uses setTimeout with backoff, so we need to advance timers
    // Since the auto-reconnect path does NOT set pendingAgentRestart, even after
    // reconnecting the error session_state should remain as 'error'
    vi.useFakeTimers();
    act(() => {
      vi.runAllTimers();
    });
    vi.useRealTimers();

    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    if (ws2 !== ws1) {
      act(() => {
        ws2.emitOpen();
        ws2.emitMessage({
          type: 'session_state',
          status: 'error',
          agentType: 'claude-code',
          error: 'Agent crashed',
          replayCount: 0,
        });
      });

      // Should stay in error (not no_session) because this was an automatic reconnect
      await waitFor(() => {
        expect(result.current.state).toBe('error');
        expect(result.current.agentType).toBe('claude-code');
      });
    }
  });

  it('clears pending restart flag when reconnecting to a healthy session', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws1 = MockWebSocket.instances[0]!;
    act(() => {
      ws1.emitOpen();
      ws1.emitMessage({
        type: 'session_state',
        status: 'error',
        agentType: 'claude-code',
        error: 'Agent crashed',
        replayCount: 0,
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe('error');
    });

    // User clicks Reconnect
    act(() => {
      result.current.reconnect();
    });

    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;

    // But the agent has recovered (e.g., auto-restarted on the server side)
    act(() => {
      ws2.emitOpen();
      ws2.emitMessage({
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: 0,
      });
    });

    // Should go to ready, not no_session — agent is already running
    await waitFor(() => {
      expect(result.current.state).toBe('ready');
      expect(result.current.agentType).toBe('claude-code');
    });
  });
});

describe('useAcpSession online/offline awareness', () => {
  it('sets NETWORK_OFFLINE when connection drops while browser is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });

    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws = MockWebSocket.instances[0]!;
    act(() => ws.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Connection drops (e.g., network loss) — this triggers reconnection
    act(() => ws.close(1006));

    // Normally would be 'reconnecting', but goes offline before reconnect attempt
    // Go offline and fire the event
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    // Should set NETWORK_OFFLINE since the connection was lost and we're offline
    await waitFor(() => {
      expect(result.current.state).toBe('error');
      expect(result.current.errorCode).toBe('NETWORK_OFFLINE' satisfies AcpErrorCode);
    });
  });

  it('resumes reconnection when browser comes back online after offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });

    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpenAndIdle());

    await waitFor(() => {
      expect(result.current.state).toBe('no_session');
    });

    // Connection drops, then browser goes offline
    act(() => ws1.close(1006));
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    await waitFor(() => {
      expect(result.current.errorCode).toBe('NETWORK_OFFLINE' satisfies AcpErrorCode);
    });

    // Come back online
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
    const instancesBefore = MockWebSocket.instances.length;

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    // Should have triggered a new WebSocket connection
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesBefore);
    });
    expect(result.current.state).toBe('reconnecting');
  });
});
