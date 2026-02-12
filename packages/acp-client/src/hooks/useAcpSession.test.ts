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

describe('useAcpSession gateway error handling', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
