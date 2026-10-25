/**
 * Whole-message transcript pages and single-message reads, against a real SQLite transcript
 * (better-sqlite3 + the real ProjectData migrations) through the same owner-guarded readers the
 * root object serves.
 *
 * Agent replies are stored one row per streamed chunk, so these tests pin: pages counted in whole
 * messages, cursors that land between messages (every chunk read exactly once across pages), role
 * filters that cannot return an empty page without progress, bounded scans that still advance,
 * tool activity summarized from metadata only, and the latest user/assistant messages.
 */
import { formatMessageCursor, type MessagePosition } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { readSourceLogicalMessage } from '../../../src/durable-objects/project-data/logical-message';
import {
  type LogicalEntry,
  type LogicalTranscriptRequest,
  readSourceLogicalTranscript,
} from '../../../src/durable-objects/project-data/logical-transcript';
import {
  assembleMessage,
  type Run,
} from '../../../src/durable-objects/project-data/logical-transcript-model';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSqlStorage } from './sql-storage-test-utils';

const PROJECT = 'project-1';
const SESSION = 'session-1';
const OWNER = {
  projectId: PROJECT,
  sessionId: SESSION,
  ownerName: PROJECT,
  generation: 1,
  migrationId: null,
};

interface SeedRow {
  id: string;
  role: string;
  content?: string;
  toolMetadata?: Record<string, unknown> | null;
  origin?: string | null;
  /** Defaults to one millisecond per row; equal values exercise cursor ties. */
  createdAt?: number;
}

describe('logical transcript', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const env = {} as Env;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions (id, topic, started_at) VALUES (?, ?, ?)`,
      SESSION,
      'topic',
      1
    );
  });

  function seed(rows: SeedRow[]): void {
    rows.forEach((row, index) => {
      sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        SESSION,
        row.role,
        row.content ?? `${row.id} `,
        row.toolMetadata ? JSON.stringify(row.toolMetadata) : null,
        row.createdAt ?? 1_000 + index,
        index + 1,
        row.origin ?? null
      );
    });
  }

  function chunks(prefix: string, count: number, role = 'assistant'): SeedRow[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `${prefix}${String(index + 1).padStart(3, '0')}`,
      role,
      content: `${prefix}${index + 1}.`,
    }));
  }

  function page(request: Partial<LogicalTranscriptRequest> = {}) {
    return readSourceLogicalTranscript(sql, env, OWNER, {
      before: null,
      limit: 10,
      roles: ['user', 'assistant', 'system'],
      maxScanRows: 5_000,
      maxMessageChars: 10_000,
      maxPageChars: 100_000,
      includeLatest: false,
      includeToolTitles: false,
      ...request,
    });
  }

  const messages = (entries: LogicalEntry[]) =>
    entries.flatMap((entry) => (entry.kind === 'message' ? [entry] : []));

  /** u1 | a1–a5 | tools | u2 | a6–a12 (one reply) | thought | tool | a13 */
  function seedConversation(): void {
    seed([
      { id: 'u1', role: 'user', content: 'First question' },
      ...chunks('a', 5),
      {
        id: 't1',
        role: 'tool',
        toolMetadata: {
          toolCallId: 'call-1',
          status: 'pending',
          kind: 'read',
          toolName: 'Read',
          title: 'Read secret.env',
        },
      },
      { id: 't2', role: 'tool', toolMetadata: { toolCallId: 'call-1', status: 'completed' } },
      { id: 'u2', role: 'user', content: 'Second question' },
      ...chunks('b', 7),
      { id: 'th1', role: 'thinking', content: 'private reasoning' },
      { id: 'th2', role: 'thinking', content: ' continued' },
      {
        id: 't3',
        role: 'tool',
        toolMetadata: {
          toolCallId: 'call-2',
          status: 'in_progress',
          kind: 'execute',
          toolName: 'Bash',
          title: 'pnpm test',
        },
      },
      { id: 't4', role: 'tool', content: 'test output', toolMetadata: { toolCallId: 'call-2' } },
      { id: 'c1', role: 'assistant', content: 'Final answer' },
    ]);
  }

  it('assembles streamed chunks into whole messages, newest first, with activity between them', async () => {
    seedConversation();

    const result = await page();

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      'message',
      'activity',
      'message',
      'message',
      'activity',
      'message',
      'message',
    ]);
    const [finalAnswer, latestActivity, secondReply] = result.entries;
    expect(finalAnswer).toMatchObject({
      kind: 'message',
      messageId: 'c1',
      content: 'Final answer',
      complete: true,
    });
    expect(secondReply).toMatchObject({
      kind: 'message',
      messageId: 'b001',
      lastRowId: 'b007',
      rowCount: 7,
      content: 'b1.b2.b3.b4.b5.b6.b7.',
    });
    // The thought and the tool call fold into one activity; the call's latest status comes from
    // an older row because the newest update only carried output.
    expect(latestActivity).toMatchObject({
      kind: 'activity',
      thinkingMessages: 1,
      toolCalls: 1,
      toolStatuses: { in_progress: 1 },
      toolKinds: { execute: 1 },
      toolNames: ['Bash'],
    });
    expect(latestActivity).not.toHaveProperty('toolTitles');
    expect(JSON.stringify(result)).not.toContain('private reasoning');
    expect(JSON.stringify(result)).not.toContain('test output');
    expect(result).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('includes bounded tool titles only when asked', async () => {
    seedConversation();

    const result = await page({ includeToolTitles: true });

    const activities = result.entries.filter((entry) => entry.kind === 'activity');
    expect(activities.map((entry) => entry.kind === 'activity' && entry.toolTitles)).toEqual([
      ['pnpm test'],
      ['Read secret.env'],
    ]);
  });

  it.each([1, 2, 3])(
    'pages every chunk exactly once with message-boundary cursors (limit %i, tied timestamps)',
    async (limit) => {
      const rows: SeedRow[] = [
        { id: 'u1', role: 'user', content: 'U1|', createdAt: 5 },
        ...chunks('a', 4).map((row) => ({ ...row, createdAt: 5 })),
        { id: 't1', role: 'tool', toolMetadata: { toolCallId: 'x' }, createdAt: 5 },
        { id: 'u2', role: 'user', content: 'U2|', createdAt: 6 },
        ...chunks('b', 6).map((row) => ({ ...row, createdAt: 6 })),
        { id: 's1', role: 'system', content: 'S1|', createdAt: 6 },
        ...chunks('c', 3).map((row) => ({ ...row, createdAt: 7 })),
      ];
      seed(rows);
      const seen: string[] = [];
      let before: MessagePosition | null = null;
      for (let pages = 0; pages < 20; pages += 1) {
        const result = await page({ before, limit });
        for (const message of messages(result.entries)) {
          expect(message.complete).toBe(true);
          expect(message.continuesInNewerPage).toBe(false);
          seen.unshift(message.content);
        }
        if (!result.nextCursor) break;
        before = result.nextCursor;
      }
      const expected = rows
        .filter((row) => row.role !== 'tool')
        .map((row) => row.content)
        .join('');
      expect(seen.join('')).toBe(expected);
    }
  );

  it('counts only the requested roles and never returns an empty page without progress', async () => {
    seed([
      { id: 'a0', role: 'assistant', content: 'old reply' },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `u${index}`,
        role: 'user',
        content: `q${index}`,
      })),
    ]);

    const first = await page({ roles: ['assistant'], limit: 1, maxScanRows: 10 });

    // Ten user rows fit the budget and none is an assistant message: the page reports them as
    // activity and still moves the cursor back.
    expect(messages(first.entries)).toHaveLength(0);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ kind: 'activity', otherMessages: { user: 9 } });
    expect(first.scanBudgetExhausted).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    let before = first.nextCursor;
    let found: string | null = null;
    for (let pages = 0; pages < 10 && before && !found; pages += 1) {
      const next = await page({ roles: ['assistant'], limit: 1, maxScanRows: 10, before });
      found = messages(next.entries)[0]?.content ?? null;
      before = next.nextCursor;
    }
    expect(found).toBe('old reply');
  });

  it('continues a message longer than the scan budget across pages without losing chunks', async () => {
    seed([{ id: 'u1', role: 'user', content: 'Go' }, ...chunks('a', 25)]);

    const first = await page({ maxScanRows: 10 });
    const [partial] = messages(first.entries);
    expect(partial).toMatchObject({ complete: false, rowCount: 10 });
    const second = await page({ maxScanRows: 10, before: first.nextCursor });
    const [middle] = messages(second.entries);
    expect(middle).toMatchObject({ complete: false, continuesInNewerPage: true, rowCount: 10 });
    const third = await page({ maxScanRows: 30, before: second.nextCursor });
    const [rest, question] = messages(third.entries);
    expect(rest).toMatchObject({ complete: true, continuesInNewerPage: true, rowCount: 5 });
    expect(question).toMatchObject({ content: 'Go' });
    expect(rest!.content + middle!.content + partial!.content).toBe(
      Array.from({ length: 25 }, (_, index) => `a${index + 1}.`).join('')
    );
  });

  it('flags a legacy stored-row cursor that points inside a message', async () => {
    seed([{ id: 'u1', role: 'user' }, ...chunks('a', 6)]);
    const legacy = formatMessageCursor({ createdAt: 1_004, sequence: 5, id: 'a004' });
    const parsed = JSON.parse(legacy) as [number, number, string];

    const result = await page({
      before: { createdAt: parsed[0], sequence: parsed[1], id: parsed[2] },
    });

    expect(messages(result.entries)[0]).toMatchObject({
      messageId: 'a001',
      content: 'a1.a2.a3.',
      continuesInNewerPage: true,
    });
  });

  it('stops before a message that would overflow the page budget, keeping the cursor exact', async () => {
    seed([
      { id: 'u1', role: 'user', content: 'x'.repeat(50) },
      { id: 'a1', role: 'assistant', content: 'y'.repeat(50) },
      { id: 'u2', role: 'user', content: 'z'.repeat(50) },
    ]);

    const first = await page({ maxPageChars: 80 });
    expect(messages(first.entries).map((message) => message.messageId)).toEqual(['u2']);
    const second = await page({ maxPageChars: 80, before: first.nextCursor });
    expect(messages(second.entries).map((message) => message.messageId)).toEqual(['a1']);
  });

  it('truncates a long message to its per-message budget and reports its full length', async () => {
    seed([{ id: 'a1', role: 'assistant', content: 'abcdefghij' }]);

    const result = await page({ maxMessageChars: 4 });

    expect(messages(result.entries)[0]).toMatchObject({
      content: 'abcd',
      contentLength: 10,
      truncated: true,
      nextOffset: 4,
    });
  });

  it('reports the latest user and assistant messages beyond a full page', async () => {
    seed([
      { id: 'u1', role: 'user', content: 'Please ship it', origin: null },
      ...chunks('a', 3),
      { id: 't1', role: 'tool', toolMetadata: { toolCallId: 'x', status: 'completed' } },
      ...chunks('b', 2),
      { id: 't2', role: 'tool', toolMetadata: { toolCallId: 'y', status: 'completed' } },
      { id: 'c1', role: 'assistant', content: 'Shipped.' },
    ]);

    const result = await page({ limit: 1, includeLatest: true });

    expect(messages(result.entries).map((message) => message.messageId)).toEqual(['c1']);
    expect(result.latest).toMatchObject({
      assistant: { messageId: 'c1', content: 'Shipped.' },
      user: { messageId: 'u1', content: 'Please ship it' },
      userSearchExhausted: false,
    });
    expect(result.nextCursor).toMatchObject({ id: 'c1' });
  });

  it('says when the latest user message is beyond the scan budget', async () => {
    seed([{ id: 'u1', role: 'user' }, ...chunks('a', 20)]);

    const result = await page({ limit: 1, includeLatest: true, maxScanRows: 5 });

    expect(result.latest).toMatchObject({ user: null, userSearchExhausted: true });
  });

  it('marks a user prompt SAM injected', async () => {
    seed([{ id: 'u1', role: 'user', content: 'Agent message from parent', origin: 'system' }]);

    const result = await page();

    expect(messages(result.entries)[0]).toMatchObject({ origin: 'system' });
  });

  describe('single message', () => {
    function read(messageId: string, extra: Record<string, unknown> = {}) {
      return readSourceLogicalMessage(sql, env, OWNER, {
        messageId,
        maxRows: 1_000,
        offset: 0,
        maxChars: 1_000,
        focus: null,
        includeThinking: false,
        includeToolTitles: false,
        ...extra,
      });
    }

    it('assembles the whole reply from any of its chunks and reads it by offset', async () => {
      seedConversation();

      const whole = await read('b004');
      expect(whole.message).toMatchObject({
        messageId: 'b001',
        content: 'b1.b2.b3.b4.b5.b6.b7.',
        complete: true,
        nextOffset: null,
      });
      const first = await read('b004', { maxChars: 9 });
      expect(first.message).toMatchObject({ content: 'b1.b2.b3.', nextOffset: 9, truncated: true });
      const rest = await read('b004', { offset: 9, maxChars: 100 });
      expect(rest.message).toMatchObject({ content: 'b4.b5.b6.b7.', offset: 9, nextOffset: null });
    });

    it('summarizes a tool span and withholds a thought unless asked', async () => {
      seedConversation();

      const tool = await read('t4');
      expect(tool.activity).toMatchObject({ toolCalls: 1, toolStatuses: { in_progress: 1 } });
      expect(JSON.stringify(tool)).not.toContain('test output');

      const hidden = await read('th2');
      expect(hidden).toMatchObject({
        thinkingWithheld: true,
        message: { content: '', nextOffset: null },
      });
      const shown = await read('th2', { includeThinking: true });
      expect(shown.message).toMatchObject({ content: 'private reasoning continued' });
    });

    it('centres an excerpt on the first match and reports whether it matched', async () => {
      seed([
        { id: 'a1', role: 'assistant', content: `${'x'.repeat(100)}NEEDLE${'y'.repeat(100)}` },
      ]);

      const hit = await read('a1', { maxChars: 30, focus: { terms: ['needle'] } });
      expect(hit.focusMatched).toBe(true);
      expect(hit.message?.content).toContain('NEEDLE');
      expect(hit.message?.offset).toBeGreaterThan(0);

      const miss = await read('a1', { maxChars: 30, focus: { terms: ['absent'] } });
      expect(miss).toMatchObject({ focusMatched: false, message: { offset: 0 } });
    });

    it('reports an incomplete message when the row bound cuts it', async () => {
      seed(chunks('a', 30));

      const result = await read('a015', { maxRows: 5 });

      expect(result.message).toMatchObject({ complete: false, rowCount: 11 });
    });

    it('returns not found for a row outside this chat', async () => {
      seedConversation();

      expect(await read('missing')).toMatchObject({ found: false, message: null });
    });
  });

  it('returns the same characters of a message whatever chunks they span', () => {
    const chunks: unknown[] = ['ab', '', 'cde', null, 'f', 'ghij', 'k'];
    // Newest first, as a run holds its rows.
    const run: Run = {
      role: 'assistant',
      rows: chunks.map((content, index) => ({ id: `r${index}`, content })).reverse(),
    };
    const whole = chunks.filter((chunk) => typeof chunk === 'string').join('');
    for (let offset = -1; offset <= whole.length + 1; offset += 1) {
      for (let maxChars = 0; maxChars <= whole.length + 1; maxChars += 1) {
        const sliced = assembleMessage(run, { offset, maxChars }, true);
        expect(sliced).toEqual(assembleMessage(run, { offset, maxChars, content: whole }, true));
        const from = Math.min(Math.max(0, offset), whole.length);
        expect(sliced.content).toBe(whole.slice(from, from + maxChars));
      }
    }
  });
});
