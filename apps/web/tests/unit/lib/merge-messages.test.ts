import { describe, expect,it } from 'vitest';

import type { ChatMessageResponse } from '../../../src/lib/api';
import { getLastMessageId,mergeMessages } from '../../../src/lib/merge-messages';

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

    it('suppresses repeated user content via append (known limitation, acceptable trade-off)', () => {
      // If a user sends the exact same text in a later turn, the append strategy
      // will suppress it via content dedup. This is an acceptable trade-off:
      // - The replace strategy (polling) will show both messages from server data
      // - The next poll cycle corrects the client state within 3 seconds
      // - The alternative (not deduping) causes 100% of follow-ups to appear twice
      const prev = [
        msg({ id: 'msg-1', role: 'user', content: 'yes', createdAt: 1 }),
        msg({ id: 'msg-2', role: 'assistant', content: 'Done.', createdAt: 2 }),
      ];
      const incoming = [
        msg({ id: 'msg-3', role: 'user', content: 'yes', createdAt: 3 }),
      ];
      const result = mergeMessages(prev, incoming, 'append');
      // Suppressed by content dedup — the next poll (replace) will correct this
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
    it('preserves earlier-loaded messages that predate the incoming window', () => {
      const prev = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
      const incoming = [msg({ id: 'c', createdAt: 3 }), msg({ id: 'd', createdAt: 4 })];
      const result = mergeMessages(prev, incoming, 'replace');
      // a and b are older than the oldest incoming (t=3), so they are preserved
      expect(result).toHaveLength(4);
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('replaces messages within the incoming time range', () => {
      // prev has messages at t=1,2,3; incoming has updated messages at t=2,3,4
      const prev = [
        msg({ id: 'a', createdAt: 1 }),
        msg({ id: 'b-old', createdAt: 2 }),
        msg({ id: 'c-old', createdAt: 3 }),
      ];
      const incoming = [
        msg({ id: 'b-new', createdAt: 2 }),
        msg({ id: 'c-new', createdAt: 3 }),
        msg({ id: 'd', createdAt: 4 }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      // a (t=1) is preserved because it's older than the oldest incoming (t=2)
      // b-old and c-old are within the incoming range and get replaced
      expect(result).toHaveLength(4);
      expect(result.map((m) => m.id)).toEqual(['a', 'b-new', 'c-new', 'd']);
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

    it('does not content-deduplicate user messages (relies on server-side dedup)', () => {
      // Replace trusts the server's authoritative data. If the server returns
      // two user messages with the same content (a server-side bug), the client
      // renders both — it's the server's job to prevent this via content dedup
      // in persistMessageBatch.
      const prev: ChatMessageResponse[] = [];
      const incoming = [
        msg({ id: 'ws-123', role: 'user', content: 'Fix the bug', createdAt: 1 }),
        msg({ id: 'batch-456', role: 'user', content: 'Fix the bug', createdAt: 2 }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      expect(result).toHaveLength(2);
    });

    it('preserves load-more messages through poll cycles (regression test)', () => {
      // Simulate: user loaded earlier messages (t=1..3), then poll returns latest (t=4..6)
      const afterLoadMore = [
        msg({ id: 'early-1', createdAt: 1 }),
        msg({ id: 'early-2', createdAt: 2 }),
        msg({ id: 'early-3', createdAt: 3 }),
        msg({ id: 'recent-4', createdAt: 4 }),
        msg({ id: 'recent-5', createdAt: 5 }),
      ];
      const pollResult = [
        msg({ id: 'recent-4', createdAt: 4 }),
        msg({ id: 'recent-5', createdAt: 5 }),
        msg({ id: 'recent-6', createdAt: 6 }),
      ];
      const result = mergeMessages(afterLoadMore, pollResult, 'replace');
      // Earlier messages (t=1..3) are preserved, recent range is updated
      expect(result).toHaveLength(6);
      expect(result.map((m) => m.id)).toEqual([
        'early-1', 'early-2', 'early-3', 'recent-4', 'recent-5', 'recent-6',
      ]);
    });

    it('does not duplicate messages at the boundary between earlier and incoming', () => {
      // Exact boundary: prev has msg at t=3, incoming starts at t=3
      const prev = [
        msg({ id: 'a', createdAt: 1 }),
        msg({ id: 'b', createdAt: 2 }),
        msg({ id: 'c', createdAt: 3 }),
      ];
      const incoming = [
        msg({ id: 'c', createdAt: 3 }),
        msg({ id: 'd', createdAt: 4 }),
      ];
      const result = mergeMessages(prev, incoming, 'replace');
      // a and b are preserved (t < 3), c comes from incoming, d is new
      expect(result).toHaveLength(4);
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
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

    it('preserves all prev messages when incoming is empty', () => {
      const result = mergeMessages([msg({ id: 'a', createdAt: 1 })], [], 'replace');
      // Empty incoming means nothing replaces — prev is preserved
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('a');
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
