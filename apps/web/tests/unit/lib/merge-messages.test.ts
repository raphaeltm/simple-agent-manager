import { describe, it, expect } from 'vitest';
import { mergeMessages, getLastMessageId } from '../../../src/lib/merge-messages';
import type { ChatMessageResponse } from '../../../src/lib/api';

function msg(overrides: Partial<ChatMessageResponse> & { id: string }): ChatMessageResponse {
  return {
    sessionId: 'session-1',
    role: 'assistant',
    content: 'Hello',
    toolMetadata: null,
    createdAt: Date.now(),
    sequence: null,
    ...overrides,
  };
}

describe('mergeMessages', () => {
  describe('append strategy', () => {
    it('appends new messages', () => {
      const prev = [msg({ id: 'a', createdAt: 1 })];
      const incoming = [msg({ id: 'b', createdAt: 2 })];
      const result = mergeMessages(prev, incoming, 'append');
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('skips messages with duplicate IDs', () => {
      const prev = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
      const incoming = [msg({ id: 'b', createdAt: 2 }), msg({ id: 'c', createdAt: 3 })];
      const result = mergeMessages(prev, incoming, 'append');
      expect(result).toHaveLength(3);
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('reconciles optimistic user messages with server-confirmed versions', () => {
      const prev = [
        msg({ id: 'optimistic-abc', role: 'user', content: 'Hello world', createdAt: 1 }),
      ];
      const incoming = [
        msg({ id: 'server-123', role: 'user', content: 'Hello world', createdAt: 1 }),
      ];
      const result = mergeMessages(prev, incoming, 'append');
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('server-123');
    });

    it('does not reconcile optimistic messages with different content', () => {
      const prev = [
        msg({ id: 'optimistic-abc', role: 'user', content: 'Hello', createdAt: 1 }),
      ];
      const incoming = [
        msg({ id: 'server-123', role: 'user', content: 'Goodbye', createdAt: 2 }),
      ];
      const result = mergeMessages(prev, incoming, 'append');
      expect(result).toHaveLength(2);
    });

    it('does not reconcile non-user optimistic messages', () => {
      const prev = [
        msg({ id: 'optimistic-abc', role: 'assistant', content: 'Hello', createdAt: 1 }),
      ];
      const incoming = [
        msg({ id: 'server-123', role: 'assistant', content: 'Hello', createdAt: 2 }),
      ];
      // Assistant messages from server are not matched to optimistic — only user messages are
      const result = mergeMessages(prev, incoming, 'append');
      expect(result).toHaveLength(2);
    });

    it('returns sorted result even when incoming is out of order', () => {
      const prev = [msg({ id: 'a', createdAt: 1 })];
      const incoming = [msg({ id: 'c', createdAt: 3 }), msg({ id: 'b', createdAt: 2 })];
      const result = mergeMessages(prev, incoming, 'append');
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('deduplicates confirmed user messages with same content but different IDs (dual-delivery)', () => {
      // Simulates: DO WebSocket persists user message (server-123), then VM agent
      // batch-persists the same content with a different ID (batch-456)
      const prev = [
        msg({ id: 'server-123', role: 'user', content: 'Hello world', createdAt: 1 }),
      ];
      const incoming = [
        msg({ id: 'batch-456', role: 'user', content: 'Hello world', createdAt: 2 }),
      ];
      const result = mergeMessages(prev, incoming, 'append');
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('server-123');
    });

    it('does not deduplicate non-user messages with same content', () => {
      // Assistant messages with same content are NOT deduplicated (they could be
      // legitimately repeated responses)
      const prev = [
        msg({ id: 'a', role: 'assistant', content: 'I can help with that', createdAt: 1 }),
      ];
      const incoming = [
        msg({ id: 'b', role: 'assistant', content: 'I can help with that', createdAt: 2 }),
      ];
      const result = mergeMessages(prev, incoming, 'append');
      expect(result).toHaveLength(2);
    });

    it('full dual-delivery scenario: optimistic → WS confirmed → batch confirmed', () => {
      // Step 1: User sends follow-up → optimistic added
      const afterOptimistic = mergeMessages(
        [],
        [msg({ id: 'optimistic-abc', role: 'user', content: 'Fix the bug', createdAt: 1 })],
        'append',
      );
      expect(afterOptimistic).toHaveLength(1);

      // Step 2: DO WebSocket broadcasts confirmed message → replaces optimistic
      const afterWsBroadcast = mergeMessages(
        afterOptimistic,
        [msg({ id: 'ws-123', role: 'user', content: 'Fix the bug', createdAt: 1 })],
        'append',
      );
      expect(afterWsBroadcast).toHaveLength(1);
      expect(afterWsBroadcast[0]!.id).toBe('ws-123');

      // Step 3: VM agent batch broadcasts same message with different ID → should be skipped
      const afterBatch = mergeMessages(
        afterWsBroadcast,
        [msg({ id: 'batch-456', role: 'user', content: 'Fix the bug', createdAt: 2 })],
        'append',
      );
      expect(afterBatch).toHaveLength(1);
      expect(afterBatch[0]!.id).toBe('ws-123');
    });

    it('reconciles optimistic AND appends new message in a single incoming batch', () => {
      const prev = [
        msg({ id: 'optimistic-abc', role: 'user', content: 'Hello', createdAt: 1 }),
      ];
      const incoming = [
        msg({ id: 'server-123', role: 'user', content: 'Hello', createdAt: 1 }),
        msg({ id: 'server-456', role: 'assistant', content: 'Response', createdAt: 2 }),
      ];
      const result = mergeMessages(prev, incoming, 'append');
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['server-123', 'server-456']);
    });
  });

  describe('replace strategy', () => {
    it('replaces messages with incoming set', () => {
      const prev = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
      const incoming = [msg({ id: 'c', createdAt: 3 }), msg({ id: 'd', createdAt: 4 })];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['c', 'd']);
    });

    it('preserves unconfirmed optimistic messages', () => {
      const prev = [
        msg({ id: 'a', createdAt: 1 }),
        msg({ id: 'optimistic-xyz', role: 'user', content: 'New message', createdAt: 5 }),
      ];
      const incoming = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result).toHaveLength(3);
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'optimistic-xyz']);
    });

    it('drops optimistic messages when server has matching confirmed message', () => {
      const prev = [
        msg({ id: 'optimistic-xyz', role: 'user', content: 'Hello', createdAt: 1 }),
      ];
      const incoming = [
        msg({ id: 'server-456', role: 'user', content: 'Hello', createdAt: 1 }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('server-456');
    });

    it('preserves only unconfirmed optimistic when two optimistics exist and one is confirmed', () => {
      const prev = [
        msg({ id: 'optimistic-1', role: 'user', content: 'First', createdAt: 1 }),
        msg({ id: 'optimistic-2', role: 'user', content: 'Second', createdAt: 2 }),
      ];
      const incoming = [
        msg({ id: 'server-1', role: 'user', content: 'First', createdAt: 1 }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result).toHaveLength(2);
      const ids = result.map((m) => m.id);
      expect(ids).toContain('server-1');
      expect(ids).toContain('optimistic-2');
      expect(ids).not.toContain('optimistic-1');
    });

    it('returns sorted result', () => {
      const prev: ChatMessageResponse[] = [];
      const incoming = [msg({ id: 'b', createdAt: 2 }), msg({ id: 'a', createdAt: 1 })];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    });
  });

  describe('prepend strategy', () => {
    it('adds older messages before existing ones', () => {
      const prev = [msg({ id: 'c', createdAt: 3 })];
      const incoming = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
      const result = mergeMessages(prev, incoming, 'prepend');
      expect(result).toHaveLength(3);
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('skips messages that already exist', () => {
      const prev = [msg({ id: 'b', createdAt: 2 }), msg({ id: 'c', createdAt: 3 })];
      const incoming = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
      const result = mergeMessages(prev, incoming, 'prepend');
      expect(result).toHaveLength(3);
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('does not duplicate when all incoming already exist', () => {
      const prev = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
      const incoming = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
      const result = mergeMessages(prev, incoming, 'prepend');
      expect(result).toHaveLength(2);
    });
  });

  describe('sort stability', () => {
    it('uses sequence as secondary sort when timestamps match', () => {
      const prev: ChatMessageResponse[] = [];
      const incoming = [
        msg({ id: 'b', createdAt: 1, sequence: 2 }),
        msg({ id: 'a', createdAt: 1, sequence: 1 }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('uses ID as tiebreaker when timestamps and sequences match', () => {
      const prev: ChatMessageResponse[] = [];
      const incoming = [
        msg({ id: 'z', createdAt: 1, sequence: 1 }),
        msg({ id: 'a', createdAt: 1, sequence: 1 }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result.map((m) => m.id)).toEqual(['a', 'z']);
    });

    it('falls back to ID sort when one message has sequence and the other does not', () => {
      const prev: ChatMessageResponse[] = [];
      const incoming = [
        msg({ id: 'z', createdAt: 1, sequence: 5 }),
        msg({ id: 'a', createdAt: 1, sequence: null }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result.map((m) => m.id)).toEqual(['a', 'z']);
    });

    it('handles null sequences gracefully', () => {
      const prev: ChatMessageResponse[] = [];
      const incoming = [
        msg({ id: 'b', createdAt: 1, sequence: null }),
        msg({ id: 'a', createdAt: 1, sequence: null }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      // Falls through to ID-based sort
      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    });
  });

  describe('edge cases', () => {
    it('handles empty prev with append', () => {
      const result = mergeMessages([], [msg({ id: 'a', createdAt: 1 })], 'append');
      expect(result).toHaveLength(1);
    });

    it('handles empty incoming with replace', () => {
      const result = mergeMessages([msg({ id: 'a', createdAt: 1 })], [], 'replace');
      expect(result).toHaveLength(0);
    });

    it('handles empty incoming with append', () => {
      const prev = [msg({ id: 'a', createdAt: 1 })];
      const result = mergeMessages(prev, [], 'append');
      expect(result).toHaveLength(1);
    });

    it('handles both empty', () => {
      const result = mergeMessages([], [], 'replace');
      expect(result).toHaveLength(0);
    });
  });
});

describe('getLastMessageId', () => {
  it('returns the last message ID', () => {
    const messages = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
    expect(getLastMessageId(messages)).toBe('b');
  });

  it('returns null for empty array', () => {
    expect(getLastMessageId([])).toBeNull();
  });
});
