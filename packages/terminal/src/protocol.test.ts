import { describe, it, expect } from 'vitest';
import {
  encodeTerminalWsListSessions,
  encodeTerminalWsReattachSession,
  isSessionReattachedMessage,
  isScrollbackMessage,
  isSessionListMessage,
  parseTerminalWsServerMessage,
} from './protocol';

describe('encodeTerminalWsListSessions', () => {
  it('encodes a list_sessions message', () => {
    const encoded = encodeTerminalWsListSessions();
    const parsed = JSON.parse(encoded);
    expect(parsed).toEqual({ type: 'list_sessions' });
  });
});

describe('encodeTerminalWsReattachSession', () => {
  it('encodes a reattach_session message with sessionId, rows, cols', () => {
    const encoded = encodeTerminalWsReattachSession('session-123', 30, 120);
    const parsed = JSON.parse(encoded);
    expect(parsed).toEqual({
      type: 'reattach_session',
      data: { sessionId: 'session-123', rows: 30, cols: 120 },
    });
  });
});

describe('isSessionReattachedMessage', () => {
  it('returns true for session_reattached messages', () => {
    const msg = parseTerminalWsServerMessage(
      JSON.stringify({
        type: 'session_reattached',
        sessionId: 'sess-1',
        data: { sessionId: 'sess-1', workingDirectory: '/home/user' },
      })
    );
    expect(msg).not.toBeNull();
    expect(isSessionReattachedMessage(msg!)).toBe(true);
  });

  it('returns false for other message types', () => {
    const msg = parseTerminalWsServerMessage(
      JSON.stringify({ type: 'output', data: { data: 'hello' } })
    );
    expect(msg).not.toBeNull();
    expect(isSessionReattachedMessage(msg!)).toBe(false);
  });
});

describe('isScrollbackMessage', () => {
  it('returns true for scrollback messages', () => {
    const msg = parseTerminalWsServerMessage(
      JSON.stringify({
        type: 'scrollback',
        sessionId: 'sess-1',
        data: { data: 'buffered output here' },
      })
    );
    expect(msg).not.toBeNull();
    expect(isScrollbackMessage(msg!)).toBe(true);
  });

  it('returns false for other message types', () => {
    const msg = parseTerminalWsServerMessage(
      JSON.stringify({ type: 'pong' })
    );
    expect(msg).not.toBeNull();
    expect(isScrollbackMessage(msg!)).toBe(false);
  });
});

describe('isSessionListMessage', () => {
  it('returns true for session_list messages', () => {
    const msg = parseTerminalWsServerMessage(
      JSON.stringify({
        type: 'session_list',
        data: {
          sessions: [
            {
              sessionId: 'sess-1',
              name: 'Terminal 1',
              status: 'running',
              workingDirectory: '/workspace',
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        },
      })
    );
    expect(msg).not.toBeNull();
    expect(isSessionListMessage(msg!)).toBe(true);
  });

  it('parses session_list with status field', () => {
    const raw = JSON.stringify({
      type: 'session_list',
      data: {
        sessions: [
          {
            sessionId: 'sess-1',
            name: 'Tab 1',
            status: 'running',
            createdAt: '2026-01-01T00:00:00Z',
          },
          {
            sessionId: 'sess-2',
            name: 'Tab 2',
            status: 'exited',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
    const msg = parseTerminalWsServerMessage(raw);
    expect(msg).not.toBeNull();
    expect(isSessionListMessage(msg!)).toBe(true);

    if (isSessionListMessage(msg!) && msg!.data) {
      expect(msg!.data.sessions).toHaveLength(2);
      expect(msg!.data.sessions[0]!.status).toBe('running');
      expect(msg!.data.sessions[1]!.status).toBe('exited');
    }
  });

  it('parses session_list with empty sessions array', () => {
    const msg = parseTerminalWsServerMessage(
      JSON.stringify({
        type: 'session_list',
        data: { sessions: [] },
      })
    );
    expect(msg).not.toBeNull();
    expect(isSessionListMessage(msg!)).toBe(true);
    if (isSessionListMessage(msg!) && msg!.data) {
      expect(msg!.data.sessions).toHaveLength(0);
    }
  });
});
