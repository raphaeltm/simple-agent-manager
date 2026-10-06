import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWebSocket } from '../../src/useWebSocket';

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

describe('useWebSocket shouldSuppressReconnect', () => {
  it('does not reconnect when shouldSuppressReconnect returns true', async () => {
    const shouldSuppressReconnect = vi.fn().mockReturnValue(true);

    renderHook(() =>
      useWebSocket({
        url: 'ws://localhost/terminal/ws?token=test',
        shouldSuppressReconnect,
      })
    );

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    // Simulate abnormal close (triggers reconnect logic)
    act(() => {
      MockWebSocket.instances[0]?.emitClose(1006);
    });

    // Wait a tick so any scheduled reconnect would have run
    await new Promise((r) => setTimeout(r, 50));

    // Should still only have 1 instance — no reconnect attempted
    expect(MockWebSocket.instances.length).toBe(1);
    expect(shouldSuppressReconnect).toHaveBeenCalled();
  });

  it('reconnects normally when shouldSuppressReconnect returns false', async () => {
    const shouldSuppressReconnect = vi.fn().mockReturnValue(false);

    renderHook(() =>
      useWebSocket({
        url: 'ws://localhost/terminal/ws?token=test',
        shouldSuppressReconnect,
        baseDelay: 10,
      })
    );

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    // Simulate abnormal close
    act(() => {
      MockWebSocket.instances[0]?.emitClose(1006);
    });

    // Wait for reconnect with very short baseDelay
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(2);
    });
  });

  it('suppresses reconnect when flag flips to true during backoff delay', async () => {
    const shouldSuppressReconnect = vi.fn().mockReturnValue(false);

    renderHook(() =>
      useWebSocket({
        url: 'ws://localhost/terminal/ws?token=test',
        shouldSuppressReconnect,
        baseDelay: 100,
        maxDelay: 100,
      })
    );

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    act(() => {
      MockWebSocket.instances[0]?.emitOpen();
    });

    // Simulate abnormal close — scheduleReconnect runs with false
    act(() => {
      MockWebSocket.instances[0]?.emitClose(1006);
    });

    // Flip the flag to true AFTER schedule but BEFORE the timer fires.
    // connect() re-checks shouldSuppressReconnect before creating a new socket.
    shouldSuppressReconnect.mockReturnValue(true);

    // Wait longer than the backoff delay
    await new Promise((r) => setTimeout(r, 200));

    // connect() was called by the timer, but the re-check prevented a new socket
    expect(MockWebSocket.instances.length).toBe(1);
  });
});
