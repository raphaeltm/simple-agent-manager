/**
 * Vertical slice for streaming-delta grouping, through the real ProjectData
 * Durable Object in the workerd runtime.
 *
 * Every test enters through the RPC a VM agent or a browser actually calls
 * (`persistMessageBatch`, `getMessages`, `getMessageToolContent`) so the
 * coalescing and the read-path grouping are exercised by the production path
 * rather than by calling the pure helpers directly (`.claude/rules/62`).
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectDataTestDouble } from './support/expected-error-doubles';

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

type BatchMessage = {
  messageId: string;
  role: string;
  content: string;
  toolMetadata: string | null;
  timestamp: string;
  sequence?: number;
  origin?: string | null;
};

let clock = Date.UTC(2026, 8, 13, 12, 0, 0);

/** One streamed delta. Timestamps advance so ordering is unambiguous. */
function delta(role: string, content: string, extra: Partial<BatchMessage> = {}): BatchMessage {
  clock += 1;
  return {
    messageId: crypto.randomUUID(),
    role,
    content,
    toolMetadata: null,
    timestamp: new Date(clock).toISOString(),
    ...extra,
  };
}

function toolRow(toolCallId: string, content: string, title: string): BatchMessage {
  return delta('tool', content, {
    toolMetadata: JSON.stringify({ toolCallId, title, kind: 'read', status: 'completed', content: [{ type: 'text', text: content }] }),
  });
}

/** The bytes a client would receive for this page, as the Worker would encode it. */
function payloadBytes(messages: unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).byteLength;
}

describe('ProjectData streaming-delta grouping', () => {
  describe('persist-time coalescing (one flush → one row)', () => {
    it('writes one row for a flush of assistant deltas and broadcasts it as one message', async () => {
      const stub = getStub('grouping-coalesce-basic');
      const sessionId = await stub.createSession(null, 'Coalesce');

      const fragments = ['I', "'ll start by cal", 'ling `', 'get_instructions` as required', '.'];
      const result = await stub.persistMessageBatch(
        sessionId,
        fragments.map((text) => delta('assistant', text))
      );

      // The flush is one logical message, so exactly one row is persisted and
      // the session's message_count reflects logical messages, not tokens.
      expect(result.persisted).toBe(1);
      const session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(1);

      const { messages } = await stub.getMessages(sessionId, 100);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'assistant',
        content: "I'll start by calling `get_instructions` as required.",
      });
    });

    it('keeps the first delta id, so a replayed flush is deduplicated and text is not doubled', async () => {
      const stub = getStub('grouping-coalesce-replay');
      const sessionId = await stub.createSession(null, 'Replay');

      // The VM agent deletes an outbox batch only after a 2xx and re-reads the
      // identical prefix on retry, so a lost response replays this exact batch.
      const batch = [delta('assistant', 'alpha'), delta('assistant', '-beta'), delta('assistant', '-gamma')];

      const first = await stub.persistMessageBatch(sessionId, batch);
      const replay = await stub.persistMessageBatch(sessionId, batch);

      expect(first.persisted).toBe(1);
      expect(replay.persisted).toBe(0);
      expect(replay.duplicates).toBe(1);

      const { messages } = await stub.getMessages(sessionId, 100);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe('alpha-beta-gamma');
      expect(messages[0]!.id).toBe(batch[0]!.messageId);
    });

    it('does not merge across a role change, a tool row, or an origin change', async () => {
      const stub = getStub('grouping-coalesce-boundaries');
      const sessionId = await stub.createSession(null, 'Boundaries');

      await stub.persistMessageBatch(sessionId, [
        delta('assistant', 'before'),
        toolRow('call-1', 'tool output', 'Read'),
        delta('assistant', 'after'),
        delta('thinking', 'pondering'),
        delta('assistant', 'visible'),
        delta('assistant', 'injected', { origin: 'system' }),
      ]);

      const { messages } = await stub.getMessages(sessionId, 100);
      expect(messages.map((m) => [m.role, m.content, m.origin ?? null])).toEqual([
        ['assistant', 'before', null],
        ['tool', 'tool output', null],
        ['assistant', 'after', null],
        ['thinking', 'pondering', null],
        ['assistant', 'visible', null],
        ['assistant', 'injected', 'system'],
      ]);
    });

    it('splits a merged row at the configured character ceiling', async () => {
      // Drives the real resolver through the DO's own env rather than passing a
      // cap in, so a default-valued defect is observable (`.claude/rules/62`).
      const stub = getStub('grouping-coalesce-cap');
      const sessionId = await stub.createSession(null, 'Cap');
      const cap = Number.parseInt(env.PROJECT_DATA_MESSAGE_GROUP_MAX_CHARS || '262144', 10);

      const chunk = 'x'.repeat(Math.ceil(cap / 2) + 1);
      const result = await stub.persistMessageBatch(sessionId, [
        delta('assistant', chunk),
        delta('assistant', chunk),
      ]);

      expect(result.persisted).toBe(2);
    });
  });

  describe('read-path grouping (turn spanning several flushes)', () => {
    it('serves one row per turn for a session written as many flushes', async () => {
      const stub = getStub('grouping-read-multi-flush');
      const sessionId = await stub.createSession(null, 'Multi flush');

      // Each persistMessageBatch is one 2-second VM-agent flush.
      await stub.persistMessageBatch(sessionId, [delta('user', 'Do the thing')]);
      for (const flush of ['The ', 'answer ', 'is ', '42.']) {
        await stub.persistMessageBatch(sessionId, [delta('assistant', flush)]);
      }

      const { messages } = await stub.getMessages(sessionId, 100);
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'Do the thing'],
        ['assistant', 'The answer is 42.'],
      ]);
    });

    it('keeps origin=system rows visible and separate (the materializeSession trap)', async () => {
      const stub = getStub('grouping-read-system-origin');
      const sessionId = await stub.createSession(null, 'System origin');

      await stub.persistMessageBatch(sessionId, [
        delta('user', 'real question'),
        delta('user', 'IMPORTANT: call get_instructions first', { origin: 'system' }),
      ]);
      await stub.persistMessageBatch(sessionId, [delta('assistant', 'ok')]);

      const { messages } = await stub.getMessages(sessionId, 100);
      // materializeSession filters COALESCE(origin,'user') != 'system' because it
      // only builds a search index. The read path must not, or the "Show system
      // context" disclosure loses the rows it renders.
      const system = messages.filter((m) => m.origin === 'system');
      expect(system).toHaveLength(1);
      expect(system[0]!.content).toBe('IMPORTANT: call get_instructions first');
      expect(messages).toHaveLength(3);
    });

    it('does not merge two turns separated by an elided tool row under a role filter', async () => {
      const stub = getStub('grouping-read-role-filter');
      const sessionId = await stub.createSession(null, 'Role filter');

      await stub.persistMessageBatch(sessionId, [delta('assistant', 'first turn')]);
      await stub.persistMessageBatch(sessionId, [toolRow('call-9', 'ran a tool', 'Bash')]);
      await stub.persistMessageBatch(sessionId, [delta('assistant', 'second turn')]);

      // Filtering to assistant makes the two turns adjacent in the result set.
      // Only the sequence-adjacency check stops them merging into one bubble.
      const { messages } = await stub.getMessages(sessionId, 100, null, null, ['assistant']);
      expect(messages.map((m) => m.content)).toEqual(['first turn', 'second turn']);
    });

    it('never absorbs a row a comment thread anchors on', async () => {
      const stub = getStub('grouping-read-comment-anchor');
      const sessionId = await stub.createSession(null, 'Comment anchor');

      const first = delta('assistant', 'part one ');
      const anchored = delta('assistant', 'part two ');
      const third = delta('assistant', 'part three');
      // Three separate flushes: without the anchor guard the read path would
      // fold all three into one row carrying only `first`'s id.
      await stub.persistMessageBatch(sessionId, [first]);
      await stub.persistMessageBatch(sessionId, [anchored]);
      await stub.persistMessageBatch(sessionId, [third]);

      await stub.createCommentThread({
        sessionId,
        messageId: anchored.messageId,
        quote: 'part two',
        body: 'what did you mean here?',
        actor: { kind: 'human', id: 'user-1', name: 'Tester' },
      });

      const { messages } = await stub.getMessages(sessionId, 100);
      const ids = messages.map((m) => m.id);
      expect(ids).toContain(anchored.messageId);
      // The anchored row starts its own group; the row after it may join that one.
      expect(messages.map((m) => m.content)).toEqual(['part one ', 'part two part three']);
    });

    it('keeps every tool call addressable for lazy content loading', async () => {
      const stub = getStub('grouping-read-tool-ids');
      const sessionId = await stub.createSession(null, 'Tool ids');

      const tools = [
        toolRow('call-a', 'output a', 'Read'),
        toolRow('call-b', 'output b', 'Grep'),
        toolRow('call-c', 'output c', 'Bash'),
      ];
      await stub.persistMessageBatch(sessionId, tools);

      const { messages } = await stub.getMessages(sessionId, 100);
      expect(messages).toHaveLength(3);

      // The collapsed count card expands to these rows and fetches each one's
      // output by id, so every tool row must remain individually resolvable.
      for (const tool of tools) {
        const content = await stub.getMessageToolContent(sessionId, tool.messageId);
        expect(content).not.toBeNull();
      }
    });

    it('keeps hasMore and the before cursor measuring raw rows', async () => {
      const stub = getStub('grouping-read-pagination');
      const sessionId = await stub.createSession(null, 'Pagination');

      // Six flushes of one delta each, alternating so they cannot all merge.
      for (let i = 0; i < 6; i++) {
        await stub.persistMessageBatch(sessionId, [
          delta(i % 2 === 0 ? 'user' : 'assistant', `m${i}`),
        ]);
      }

      const page = await stub.getMessages(sessionId, 3);
      expect(page.hasMore).toBe(true);
      expect(page.messages.length).toBeGreaterThan(0);

      const oldest = page.messages[0]!.createdAt as number;
      const earlier = await stub.getMessages(sessionId, 10, oldest);
      // Every earlier row is strictly older, so "load earlier" cannot re-serve
      // anything already on screen.
      for (const message of earlier.messages) {
        expect(message.createdAt as number).toBeLessThan(oldest);
      }
    });
  });

  describe('payload', () => {
    it('shrinks a token-fragmented session by an order of magnitude', async () => {
      const stub = getStub('grouping-payload-measure');
      const sessionId = await stub.createSession(null, 'Measure');

      // Reproduces the measured production shape: many one-to-four character
      // assistant rows spread across flushes.
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(6);
      const fragments = text.match(/.{1,4}/g) ?? [];
      await stub.persistMessageBatch(sessionId, [delta('user', 'go')]);
      for (const fragment of fragments) {
        await stub.persistMessageBatch(sessionId, [delta('assistant', fragment)]);
      }

      const grouped = await stub.getMessages(sessionId, 5000);
      // Raw rows still in storage, i.e. what the old read path would have served.
      const rawRows = await stub.getMessageCount(sessionId);

      expect(rawRows).toBe(fragments.length + 1);
      expect(grouped.messages.length).toBe(2);
      // Each row the old path served carried a full envelope (id, sessionId,
      // role, createdAt, sequence, origin, toolMetadata) around ~4 characters of
      // text, so collapsing to 2 rows is an order-of-magnitude payload cut.
      const envelopeBytesPerRow = payloadBytes([{ ...grouped.messages[0], content: 'four' }]);
      expect(payloadBytes(grouped.messages)).toBeLessThan((rawRows * envelopeBytesPerRow) / 5);
      // No text is lost in the process.
      expect(grouped.messages[1]!.content).toBe(text);
    });
  });
});
