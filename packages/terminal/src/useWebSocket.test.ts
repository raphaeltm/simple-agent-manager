import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn();

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code }));
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitClose(code = 1006): void {
    this.close(code);
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useWebSocket URL resolution', () => {
  it('uses resolver URL for initial connect and reconnect attempts', async () => {
    const resolveUrl = vi
      .fn()
      .mockResolvedValueOnce('ws://localhost/terminal/ws?token=first')
      .mockResolvedValueOnce('ws://localhost/terminal/ws?token=second');

    const { result } = renderHook(() =>
      useWebSocket({
        url: 'ws://localhost/terminal/ws?token=stale',
        resolveUrl,
        maxRetries: 2,
        baseDelay: 10,
        maxDelay: 10,
      })
    );

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    expect(MockWebSocket.instances[0]?.url).toContain('token=first');

    act(() => {
      MockWebSocket.instances[0]?.emitOpen();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('connected');
    });

    act(() => {
      MockWebSocket.instances[0]?.emitClose(1006);
    });

    await waitFor(() => {
      expect(result.current.state).toBe('reconnecting');
    });

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(2);
    });
    expect(MockWebSocket.instances[1]?.url).toContain('token=second');
    expect(resolveUrl).toHaveBeenCalledTimes(2);
  });

  it('falls back to static URL when resolver returns null', async () => {
    const resolveUrl = vi.fn().mockResolvedValue(null);

    renderHook(() =>
      useWebSocket({
        url: 'ws://localhost/terminal/ws?token=fallback',
        resolveUrl,
      })
    );

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    expect(MockWebSocket.instances[0]?.url).toContain('token=fallback');
  });
});
