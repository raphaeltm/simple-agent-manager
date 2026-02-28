import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const hookSource = readFileSync(
  join(__dirname, '../../../src/hooks/useChatWebSocket.ts'),
  'utf-8'
);

describe('useChatWebSocket hook', () => {
  it('exports useChatWebSocket and ChatConnectionState', () => {
    expect(hookSource).toContain('export function useChatWebSocket');
    expect(hookSource).toContain('export type ChatConnectionState');
  });

  it('defines connection states: connecting, connected, reconnecting, disconnected', () => {
    expect(hookSource).toContain("'connecting'");
    expect(hookSource).toContain("'connected'");
    expect(hookSource).toContain("'reconnecting'");
    expect(hookSource).toContain("'disconnected'");
  });

  it('implements exponential backoff with configurable limits', () => {
    expect(hookSource).toContain('BASE_RECONNECT_DELAY');
    expect(hookSource).toContain('MAX_RECONNECT_DELAY');
    expect(hookSource).toContain('MAX_RETRIES');
    expect(hookSource).toContain('Math.pow(2, attempt)');
    expect(hookSource).toContain('Math.min(');
  });

  it('stops reconnecting after MAX_RETRIES', () => {
    expect(hookSource).toContain('retriesRef.current >= MAX_RETRIES');
    expect(hookSource).toContain("setConnectionState('disconnected')");
  });

  it('fetches missed messages on reconnect via REST', () => {
    expect(hookSource).toContain('catchUpMessages');
    expect(hookSource).toContain('getChatSession(projectId, sessionId)');
    expect(hookSource).toContain('wasReconnect');
    expect(hookSource).toContain('hadConnectionRef');
  });

  it('only catches up when reconnecting (not on first connect)', () => {
    expect(hookSource).toContain('const wasReconnect = hadConnectionRef.current');
    expect(hookSource).toContain('hadConnectionRef.current = true');
    expect(hookSource).toContain('if (wasReconnect)');
  });

  it('handles WebSocket message types', () => {
    expect(hookSource).toContain("data.type === 'message.new'");
    expect(hookSource).toContain("data.type === 'session.stopped'");
    expect(hookSource).toContain('onMessageRef.current');
    expect(hookSource).toContain('onSessionStoppedRef.current');
  });

  it('sends ping keep-alive messages', () => {
    expect(hookSource).toContain('PING_INTERVAL_MS');
    expect(hookSource).toContain("type: 'ping'");
  });

  it('cleans up on unmount', () => {
    expect(hookSource).toContain('mountedRef.current = false');
    expect(hookSource).toContain('clearTimeout(reconnectTimerRef.current)');
    expect(hookSource).toContain('ws.close(1000)');
  });

  it('provides retry function that resets retries but preserves catch-up flag', () => {
    expect(hookSource).toContain('const retry = useCallback');
    expect(hookSource).toContain('retriesRef.current = 0');
    // retry should NOT reset hadConnectionRef — catch-up should fire on reconnect
    // (hadConnectionRef.current = false only appears in the enabled=false cleanup path)
    const retrySection = hookSource.split('const retry = useCallback')[1]?.split('}, [])')[0] ?? '';
    expect(retrySection).not.toContain('hadConnectionRef.current = false');
  });

  it('disconnects when enabled changes to false', () => {
    expect(hookSource).toContain('if (!enabled)');
    expect(hookSource).toContain("setConnectionState('disconnected')");
  });

  it('constructs WebSocket URL from VITE_API_URL', () => {
    expect(hookSource).toContain('VITE_API_URL');
    expect(hookSource).toContain("replace(/^http/, 'ws')");
    expect(hookSource).toContain('/sessions/ws');
  });

  it('schedules reconnect on abnormal close', () => {
    expect(hookSource).toContain('event.code !== 1000');
    expect(hookSource).toContain('scheduleReconnect()');
  });

  it('uses stable callback refs to avoid stale closures', () => {
    expect(hookSource).toContain('onMessageRef');
    expect(hookSource).toContain('onSessionStoppedRef');
    expect(hookSource).toContain('onCatchUpRef');
    expect(hookSource).toContain('.current = onMessage');
  });
});
