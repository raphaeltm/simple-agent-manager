import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the API module
vi.mock('../../../src/lib/api', () => ({
  getAdminLogStreamUrl: () => 'ws://localhost:8787/api/admin/observability/logs/stream',
}));

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sent: string[] = [];
  closed = false;
  closeCode?: number;

  constructor(url: string) {
    this.url = url;
    // Auto-register in the global tracker
    mockWebSocketInstances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.closed = true;
    this.closeCode = code;
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason: '', wasClean: false } as CloseEvent);
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }
}

let mockWebSocketInstances: MockWebSocket[] = [];

describe('useAdminLogStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWebSocketInstances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Dynamic import after mocks are set up
  async function importHook() {
    // Reset module cache to pick up fresh mocks
    const mod = await import('../../../src/hooks/useAdminLogStream');
    return mod.useAdminLogStream;
  }

  it('should start in connecting state', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    expect(result.current.state).toBe('connecting');
    expect(result.current.entries).toEqual([]);
    expect(result.current.paused).toBe(false);
  });

  it('should transition to connected on WebSocket open', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    expect(ws).toBeDefined();

    act(() => {
      ws.simulateOpen();
    });

    expect(result.current.state).toBe('connected');
  });

  it('should add entries on log messages', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    act(() => {
      ws.simulateMessage({
        type: 'log',
        entry: {
          timestamp: '2026-02-14T12:00:00Z',
          level: 'info',
          event: 'http.request',
          message: 'GET /health',
          details: {},
          scriptName: 'workspaces-api',
        },
      });
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].message).toBe('GET /health');
  });

  it('should update clientCount on status messages', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    act(() => {
      ws.simulateMessage({ type: 'status', connected: true, clientCount: 3 });
    });

    expect(result.current.clientCount).toBe(3);
  });

  it('should respect buffer size limit', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream(5)); // Small buffer

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    // Add 10 entries
    for (let i = 0; i < 10; i++) {
      act(() => {
        ws.simulateMessage({
          type: 'log',
          entry: {
            timestamp: `2026-02-14T12:00:${String(i).padStart(2, '0')}Z`,
            level: 'info',
            event: 'test',
            message: `Log ${i}`,
            details: {},
            scriptName: 'test',
          },
        });
      });
    }

    expect(result.current.entries).toHaveLength(5);
    // Should keep the latest entries
    expect(result.current.entries[0].message).toBe('Log 5');
    expect(result.current.entries[4].message).toBe('Log 9');
  });

  it('should send filter message on setLevels', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    act(() => {
      result.current.setLevels(['error', 'warn']);
    });

    expect(result.current.filter.levels).toEqual(['error', 'warn']);
    // Check that a filter message was sent
    const filterMessages = ws.sent.filter((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === 'filter';
    });
    expect(filterMessages.length).toBeGreaterThan(0);
  });

  it('should send filter message on setSearch', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    act(() => {
      result.current.setSearch('timeout');
    });

    expect(result.current.filter.search).toBe('timeout');
    const filterMessages = ws.sent.filter((m) => JSON.parse(m).type === 'filter');
    expect(filterMessages.length).toBeGreaterThan(0);
    const lastFilter = JSON.parse(filterMessages[filterMessages.length - 1]);
    expect(lastFilter.search).toBe('timeout');
  });

  it('should toggle pause and send pause/resume messages', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    // Pause
    act(() => {
      result.current.togglePause();
    });

    expect(result.current.paused).toBe(true);
    expect(ws.sent.some((m) => JSON.parse(m).type === 'pause')).toBe(true);

    // Resume
    act(() => {
      result.current.togglePause();
    });

    expect(result.current.paused).toBe(false);
    expect(ws.sent.some((m) => JSON.parse(m).type === 'resume')).toBe(true);
  });

  it('should clear entries', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    // Add some entries
    act(() => {
      ws.simulateMessage({
        type: 'log',
        entry: { timestamp: '2026-02-14T12:00:00Z', level: 'info', event: 'test', message: 'test', details: {}, scriptName: 'test' },
      });
    });

    expect(result.current.entries).toHaveLength(1);

    act(() => {
      result.current.clear();
    });

    expect(result.current.entries).toHaveLength(0);
  });

  it('should reconnect on abnormal close', async () => {
    const useAdminLogStream = await importHook();
    renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    // Simulate abnormal close
    act(() => {
      ws.simulateClose(1006);
    });

    // Should schedule reconnect
    act(() => {
      vi.advanceTimersByTime(1500); // Past the base reconnect delay
    });

    // A new WebSocket should have been created
    expect(mockWebSocketInstances.length).toBeGreaterThan(1);
  });

  it('should not reconnect on normal close (1000)', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    act(() => {
      ws.simulateClose(1000);
    });

    expect(result.current.state).toBe('disconnected');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // No new WebSocket should be created
    expect(mockWebSocketInstances.length).toBe(1);
  });

  it('should retry on manual retry()', async () => {
    const useAdminLogStream = await importHook();
    const { result } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });
    act(() => { ws.simulateClose(1000); });

    expect(result.current.state).toBe('disconnected');

    act(() => {
      result.current.retry();
    });

    // A new WebSocket should be created
    expect(mockWebSocketInstances.length).toBe(2);
  });

  it('should clean up WebSocket on unmount', async () => {
    const useAdminLogStream = await importHook();
    const { unmount } = renderHook(() => useAdminLogStream());

    const ws = mockWebSocketInstances[0];
    act(() => { ws.simulateOpen(); });

    unmount();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1000);
  });
});
