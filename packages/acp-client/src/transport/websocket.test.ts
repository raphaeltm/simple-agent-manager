import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AcpLifecycleEvent } from './types';
import { createAcpWebSocketTransport } from './websocket';

// Minimal WebSocket mock for jsdom
function createMockWebSocket(): WebSocket & {
  _listeners: Record<string, Array<(ev: unknown) => void>>;
  _simulateMessage: (data: string) => void;
  _simulateClose: () => void;
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

    _simulateClose() {
      for (const fn of listeners['close'] ?? []) {
        fn({});
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
    _simulateClose: () => void;
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
});
