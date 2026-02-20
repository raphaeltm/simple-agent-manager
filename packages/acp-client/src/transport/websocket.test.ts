import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AcpLifecycleEvent } from './types';
import { createAcpWebSocketTransport } from './websocket';

// Minimal WebSocket mock for jsdom
function createMockWebSocket(): WebSocket & {
  _listeners: Record<string, Array<(ev: unknown) => void>>;
  _simulateMessage: (data: string) => void;
  _simulateOpen: () => void;
  _simulateClose: (code?: number, reason?: string) => void;
  _simulateError: () => void;
} {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};

  const ws = {
    readyState: WebSocket.OPEN,
    _listeners: listeners,

    addEventListener(type: string, fn: (ev: unknown) => void) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },

    send: vi.fn(),
    close: vi.fn(),

    _simulateMessage(data: string) {
      for (const fn of listeners['message'] ?? []) {
        fn({ data });
      }
    },

    _simulateOpen() {
      for (const fn of listeners['open'] ?? []) {
        fn({});
      }
    },

    _simulateClose(code = 1006, reason = '') {
      for (const fn of listeners['close'] ?? []) {
        fn({ code, reason });
      }
    },

    _simulateError() {
      for (const fn of listeners['error'] ?? []) {
        fn(new Event('error'));
      }
    },
  } as unknown as WebSocket & {
    _listeners: Record<string, Array<(ev: unknown) => void>>;
    _simulateMessage: (data: string) => void;
    _simulateOpen: () => void;
    _simulateClose: (code?: number, reason?: string) => void;
    _simulateError: () => void;
  };

  return ws;
}

describe('createAcpWebSocketTransport', () => {
  let ws: ReturnType<typeof createMockWebSocket>;
  let onAgentStatus: ReturnType<typeof vi.fn>;
  let onAcpMessage: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let lifecycleEvents: AcpLifecycleEvent[];
  let onLifecycleEvent: (event: AcpLifecycleEvent) => void;

  beforeEach(() => {
    ws = createMockWebSocket();
    onAgentStatus = vi.fn();
    onAcpMessage = vi.fn();
    onClose = vi.fn();
    onError = vi.fn();
    lifecycleEvents = [];
    onLifecycleEvent = (event) => lifecycleEvents.push(event);
  });

  it('routes agent_status messages to onAgentStatus', () => {
    createAcpWebSocketTransport(ws, onAgentStatus, onAcpMessage, onClose, onError, onLifecycleEvent);

    ws._simulateMessage(JSON.stringify({
      type: 'agent_status',
      status: 'ready',
      agentType: 'claude-code',
    }));

    expect(onAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent_status', status: 'ready' })
    );
    expect(onAcpMessage).not.toHaveBeenCalled();
  });

  it('routes non-control messages to onAcpMessage', () => {
    createAcpWebSocketTransport(ws, onAgentStatus, onAcpMessage, onClose, onError, onLifecycleEvent);

    ws._simulateMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { foo: 'bar' },
    }));

    expect(onAcpMessage).toHaveBeenCalledWith(
      expect.objectContaining({ jsonrpc: '2.0', method: 'session/update' })
    );
    expect(onAgentStatus).not.toHaveBeenCalled();
  });

  it('logs lifecycle event when JSON parse fails', () => {
    createAcpWebSocketTransport(ws, onAgentStatus, onAcpMessage, onClose, onError, onLifecycleEvent);

    ws._simulateMessage('this is not valid JSON!!!');

    expect(onAgentStatus).not.toHaveBeenCalled();
    expect(onAcpMessage).not.toHaveBeenCalled();

    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0]).toEqual(expect.objectContaining({
      source: 'acp-transport',
      level: 'warn',
      message: 'Failed to parse WebSocket message as JSON',
    }));
    expect(lifecycleEvents[0]!.context).toEqual(expect.objectContaining({
      dataLength: expect.any(Number),
      preview: expect.stringContaining('this is not valid JSON'),
    }));
  });

  it('logs lifecycle event when sending on closed WebSocket', () => {
    const transport = createAcpWebSocketTransport(
      ws, onAgentStatus, onAcpMessage, onClose, onError, onLifecycleEvent
    );

    // Simulate closed WebSocket
    (ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;

    transport.sendAcpMessage({ test: true });

    expect(ws.send).not.toHaveBeenCalled();
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0]).toEqual(expect.objectContaining({
      source: 'acp-transport',
      level: 'warn',
      message: 'Send failed: WebSocket not open',
      context: expect.objectContaining({ messageType: 'acp' }),
    }));
  });

  it('logs lifecycle event when sendSelectAgent on closed WebSocket', () => {
    const transport = createAcpWebSocketTransport(
      ws, onAgentStatus, onAcpMessage, onClose, onError, onLifecycleEvent
    );

    (ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;

    transport.sendSelectAgent('claude-code');

    expect(ws.send).not.toHaveBeenCalled();
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0]).toEqual(expect.objectContaining({
      source: 'acp-transport',
      level: 'warn',
      message: 'Send failed: WebSocket not open',
      context: expect.objectContaining({
        messageType: 'select_agent',
        agentType: 'claude-code',
      }),
    }));
  });

  it('sends normally when WebSocket is open', () => {
    const transport = createAcpWebSocketTransport(
      ws, onAgentStatus, onAcpMessage, onClose, onError, onLifecycleEvent
    );

    transport.sendAcpMessage({ test: true });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ test: true }));
    expect(lifecycleEvents).toHaveLength(0);
  });

  it('does not fail when no lifecycle callback is provided', () => {
    const transport = createAcpWebSocketTransport(
      ws, onAgentStatus, onAcpMessage, onClose, onError
      // no lifecycle callback
    );

    // Parse failure should not throw
    ws._simulateMessage('invalid json');
    expect(onAcpMessage).not.toHaveBeenCalled();

    // Send on closed should not throw
    (ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
    transport.sendAcpMessage({ test: true });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('calls onClose when WebSocket closes', () => {
    createAcpWebSocketTransport(ws, onAgentStatus, onAcpMessage, onClose, onError, onLifecycleEvent);

    ws._simulateClose();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('forwards close code and reason to onClose callback', () => {
    createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      onLifecycleEvent,
    });

    ws._simulateClose(1001, 'going_away');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(1001, 'going_away');
  });

  it('routes pong messages as control (not to onAcpMessage)', () => {
    createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      onError,
      onLifecycleEvent,
    });

    ws._simulateMessage(JSON.stringify({ type: 'pong' }));

    expect(onAcpMessage).not.toHaveBeenCalled();
    expect(onAgentStatus).not.toHaveBeenCalled();
  });

  it('responds to ping messages with pong', () => {
    createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      onError,
      onLifecycleEvent,
    });

    ws._simulateMessage(JSON.stringify({ type: 'ping' }));

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
    expect(onAcpMessage).not.toHaveBeenCalled();
  });
});

describe('heartbeat', () => {
  let ws: ReturnType<typeof createMockWebSocket>;
  let onAgentStatus: ReturnType<typeof vi.fn>;
  let onAcpMessage: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let lifecycleEvents: AcpLifecycleEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    ws = createMockWebSocket();
    onAgentStatus = vi.fn();
    onAcpMessage = vi.fn();
    onClose = vi.fn();
    lifecycleEvents = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends ping at configured interval when connection is open', () => {
    createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      onLifecycleEvent: (e) => lifecycleEvents.push(e),
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 2000,
    });

    // No ping sent immediately
    expect(ws.send).not.toHaveBeenCalled();

    // Advance past first interval
    vi.advanceTimersByTime(5000);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
  });

  it('closes WebSocket if pong not received within timeout', () => {
    createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      onLifecycleEvent: (e) => lifecycleEvents.push(e),
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 2000,
    });

    // Trigger ping
    vi.advanceTimersByTime(5000);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));

    // No pong received, advance past timeout
    vi.advanceTimersByTime(2000);

    // Should have closed the WebSocket to trigger reconnect
    expect(ws.close).toHaveBeenCalledWith(4000, 'heartbeat_timeout');

    // Should have logged a lifecycle event
    const timeoutEvent = lifecycleEvents.find(e => e.message.includes('pong timeout'));
    expect(timeoutEvent).toBeDefined();
    expect(timeoutEvent?.level).toBe('warn');
  });

  it('does not close WebSocket if pong received in time', () => {
    createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      onLifecycleEvent: (e) => lifecycleEvents.push(e),
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 2000,
    });

    // Trigger ping
    vi.advanceTimersByTime(5000);

    // Pong received within timeout
    ws._simulateMessage(JSON.stringify({ type: 'pong' }));

    // Advance past what would be the timeout
    vi.advanceTimersByTime(3000);

    // Should NOT have closed
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('does not send pings when heartbeat is disabled (interval = 0)', () => {
    createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      heartbeatIntervalMs: 0,
    });

    vi.advanceTimersByTime(60000);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('stops heartbeat on transport.close()', () => {
    const transport = createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 2000,
    });

    transport.close();

    // Advance past interval — no ping should be sent
    vi.advanceTimersByTime(10000);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('stops heartbeat on WebSocket close', () => {
    createAcpWebSocketTransport({
      ws,
      onAgentStatus,
      onAcpMessage,
      onClose,
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 2000,
    });

    // Close the WebSocket
    ws._simulateClose();

    // Advance past interval — no ping should be sent
    vi.advanceTimersByTime(10000);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
