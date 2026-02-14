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
      ws.emitOpen();
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
      ws.emitOpen();
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
    act(() => ws1.emitOpen());

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
    act(() => ws.emitOpen());

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

describe('useAcpSession manual reconnect', () => {
  it('exposes a reconnect function that creates a new connection', async () => {
    const { result } = renderHook(() => useAcpSession({
      wsUrl: 'ws://localhost/agent/ws',
    }));

    // First connection opens then closes
    const ws1 = MockWebSocket.instances[0]!;
    act(() => ws1.emitOpen());

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
    act(() => ws.emitOpen());

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
