/**
 * The Comments page reader's window around a comment's anchored message, read against a real
 * SQLite transcript (better-sqlite3 + the real ProjectData migrations) through the same
 * owner-guarded read the root object serves.
 *
 * Agent replies are stored one row per streamed chunk, so the window is counted in displayed
 * messages. These tests pin that the whole anchored message is always included — including
 * when the anchor is a later chunk — and that each side stops after the configured number of
 * messages, the row cap, or the start/end of the transcript.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  type MessageContextRequest,
  readSourceMessageContext,
} from '../../../src/durable-objects/project-data/message-context';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSqlStorage } from './sql-storage-test-utils';

const PROJECT = 'project-1';
const SESSION = 'session-1';

interface SeedRow {
  id: string;
  role: string;
  content?: string;
  toolMetadata?: Record<string, unknown> | null;
  /** Defaults to one millisecond per row; equal values exercise cursor ties. */
  createdAt?: number;
}

describe('message context window', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const env = {} as Env;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    seedSession(SESSION);
  });

  function seedSession(sessionId: string): void {
    sql.exec(
      `INSERT INTO chat_sessions (id, topic, started_at) VALUES (?, ?, ?)`,
      sessionId,
      `topic ${sessionId}`,
      1
    );
  }

  function seed(rows: SeedRow[], sessionId = SESSION): void {
    rows.forEach((row, index) => {
      sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        sessionId,
        row.role,
        row.content ?? `${row.id} `,
        row.toolMetadata ? JSON.stringify(row.toolMetadata) : null,
        row.createdAt ?? 1_000 + index,
        index + 1
      );
    });
  }

  function chunks(prefix: string, count: number, role = 'assistant'): SeedRow[] {
    return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}`, role }));
  }

  function read(request: Partial<MessageContextRequest> & { messageId: string }) {
    return readSourceMessageContext(
      sql,
      env,
      {
        projectId: PROJECT,
        sessionId: SESSION,
        ownerName: PROJECT,
        generation: 1,
        migrationId: null,
      },
      { messagesEachSide: 1, maxRows: 1_000, compact: false, ...request }
    );
  }

  const ids = (rows: Record<string, unknown>[]) => rows.map((row) => row.id);

  /**
   * u1 | a1–a5 (one reply) | t1 | u2 | a6–a12 (one reply) | th1–th2 (one thought) | t2 | a13 | u3
   */
  function seedConversation(): void {
    seed([
      { id: 'u1', role: 'user' },
      ...chunks('a', 5),
      { id: 't1', role: 'tool', toolMetadata: { toolCallId: 'call-1', title: 'Read' } },
      { id: 'u2', role: 'user' },
      ...chunks('a', 12).slice(5),
      ...chunks('th', 2, 'thinking'),
      { id: 't2', role: 'tool', toolMetadata: { toolCallId: 'call-2', title: 'Edit' } },
      { id: 'a13', role: 'assistant' },
      { id: 'u3', role: 'user' },
    ]);
  }

  it('includes the whole reply an anchor on a later chunk belongs to, then one message each side', async () => {
    seedConversation();

    const window = await read({ messageId: 'a8' });

    expect(window.found).toBe(true);
    // Before: a6, a7 finish the anchored reply; u2 is the one message before it.
    // After: a9–a12 finish the reply (the quote is somewhere in here); th1–th2 is one message.
    expect(ids(window.messages)).toEqual([
      'u2',
      'a6',
      'a7',
      'a8',
      'a9',
      'a10',
      'a11',
      'a12',
      'th1',
      'th2',
    ]);
    expect(window).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
  });

  it('counts a single-row message once and stops at the start and end of the transcript', async () => {
    seedConversation();

    const window = await read({ messageId: 'u2', messagesEachSide: 50 });

    expect(ids(window.messages)).toEqual([
      'u1',
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      't1',
      'u2',
      'a6',
      'a7',
      'a8',
      'a9',
      'a10',
      'a11',
      'a12',
      'th1',
      'th2',
      't2',
      'a13',
      'u3',
    ]);
    expect(window).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false });
  });

  it('keeps each side to its own message count around a single-row anchor', async () => {
    seedConversation();

    const window = await read({ messageId: 't2', messagesEachSide: 2 });

    // Before: th1–th2 (one), then a6–a12 (one, kept whole). After: a13, u3.
    expect(ids(window.messages)).toEqual([
      'a6',
      'a7',
      'a8',
      'a9',
      'a10',
      'a11',
      'a12',
      'th1',
      'th2',
      't2',
      'a13',
      'u3',
    ]);
    expect(window).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });
  });

  /**
   * The shape seen on staging: two calls start in parallel, then their updates arrive. The chat
   * shows the run as one tool-call group; a window cut after t1 showed call-1 still running,
   * because its completion is t3.
   */
  it('never cuts a run of tool rows, so every call in the window has its updates', async () => {
    seed([
      { id: 'u1', role: 'user' },
      ...chunks('a', 3),
      { id: 't1', role: 'tool', toolMetadata: { toolCallId: 'call-1', status: 'pending' } },
      { id: 't2', role: 'tool', toolMetadata: { toolCallId: 'call-2', status: 'pending' } },
      { id: 't3', role: 'tool', toolMetadata: { toolCallId: 'call-1', status: 'completed' } },
      { id: 't4', role: 'tool', toolMetadata: { toolCallId: 'call-2', status: 'in_progress' } },
      { id: 't5', role: 'tool', toolMetadata: { toolCallId: 'call-2', status: 'completed' } },
      ...chunks('b', 2),
      { id: 'u2', role: 'user' },
    ]);

    // After the anchored reply, the whole run is the one message.
    const after = await read({ messageId: 'a2' });
    expect(ids(after.messages)).toEqual(['u1', 'a1', 'a2', 'a3', 't1', 't2', 't3', 't4', 't5']);
    expect(after).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true });

    // Before the anchored reply too: the run whole, not its last update alone.
    const before = await read({ messageId: 'b1' });
    expect(ids(before.messages)).toEqual(['t1', 't2', 't3', 't4', 't5', 'b1', 'b2', 'u2']);
    expect(before).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });

    // A comment on one row of the run opens with the whole group, then a message each side.
    const onTool = await read({ messageId: 't3' });
    expect(ids(onTool.messages)).toEqual([
      'a1',
      'a2',
      'a3',
      't1',
      't2',
      't3',
      't4',
      't5',
      'b1',
      'b2',
    ]);
    expect(onTool).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
  });

  it('stops each side at the row cap and says more exists', async () => {
    seed([{ id: 'u1', role: 'user' }, ...chunks('a', 40), { id: 'u2', role: 'user' }]);

    const window = await read({ messageId: 'a20', maxRows: 5 });

    expect(ids(window.messages)).toEqual([
      'a15',
      'a16',
      'a17',
      'a18',
      'a19',
      'a20',
      'a21',
      'a22',
      'a23',
      'a24',
      'a25',
    ]);
    expect(window).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
  });

  it('pages through a reply longer than one scan page, across timestamp ties, without gaps', async () => {
    // 700 chunks, every five sharing one millisecond: the scan must page by exact cursor.
    const reply = chunks('a', 700).map((row, index) => ({
      ...row,
      createdAt: 5_000 + Math.floor(index / 5),
    }));
    seed([
      { id: 'u1', role: 'user', createdAt: 4_000 },
      ...reply,
      { id: 'u2', role: 'user', createdAt: 9_000 },
    ]);

    const window = await read({ messageId: 'a351', messagesEachSide: 1, maxRows: 1_000 });

    expect(ids(window.messages)).toEqual(['u1', ...reply.map((row) => row.id), 'u2']);
    expect(window).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false });
  });

  it('stops a side at half the RPC size budget, before the row and message limits', async () => {
    // Ten single-row messages of ~3 MB each (1.5M UTF-16 characters); half of the 30 MiB RPC
    // budget holds five of them. Neither the row cap nor the message count is reached.
    const large = 'x'.repeat(1_500_000);
    seed([
      { id: 'u0', role: 'user', content: 'Start' },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `big-${index + 1}`,
        role: 'user',
        content: large,
      })),
    ]);

    const window = await read({ messageId: 'u0', messagesEachSide: 50, maxRows: 1_000 });

    expect(ids(window.messages)).toEqual(['u0', 'big-1', 'big-2', 'big-3', 'big-4', 'big-5']);
    expect(window).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true });
  });

  it('counts the anchored row against the budget, so a large anchor shrinks both sides', async () => {
    // A ~12 MB anchor leaves (30 MiB - 12 MB) / 2 ≈ 9.7 MB a side: three ~3 MB rows, not five.
    const large = 'x'.repeat(1_500_000);
    seed([
      { id: 'anchor', role: 'user', content: 'y'.repeat(6_000_000) },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `big-${index + 1}`,
        role: 'user',
        content: large,
      })),
    ]);

    const window = await read({ messageId: 'anchor', messagesEachSide: 50, maxRows: 1_000 });

    expect(ids(window.messages)).toEqual(['anchor', 'big-1', 'big-2', 'big-3']);
    expect(window).toMatchObject({ hasMoreAfter: true });
  });

  it('reports a missing anchor without reading anything', async () => {
    seedConversation();

    expect(await read({ messageId: 'gone' })).toEqual({
      found: false,
      messages: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });

  it('does not find a message that belongs to another session, and never mixes sessions', async () => {
    seedSession('session-2');
    seed(
      [
        { id: 'other-1', role: 'user' },
        { id: 'other-2', role: 'assistant' },
      ],
      'session-2'
    );
    seed([
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
    ]);

    // Attack: an id from session-2 addressed through session-1.
    expect((await read({ messageId: 'other-1' })).found).toBe(false);
    // Owner control: the same read for session-1's own message finds only session-1 rows.
    const own = await read({ messageId: 'u1', messagesEachSide: 5 });
    expect(ids(own.messages)).toEqual(['u1', 'a1']);
  });

  it('strips tool output in compact mode, like the chat transcript', async () => {
    seed([
      { id: 'u1', role: 'user' },
      {
        id: 't1',
        role: 'tool',
        toolMetadata: { toolCallId: 'call-1', content: [{ type: 'text', text: 'x'.repeat(500) }] },
      },
    ]);

    const window = await read({ messageId: 'u1', compact: true });

    const tool = window.messages.find((row) => row.id === 't1');
    expect(tool?.toolMetadata).toMatchObject({ toolCallId: 'call-1' });
    expect((tool?.toolMetadata as Record<string, unknown>).content).toBeUndefined();
    expect((tool?.toolMetadata as Record<string, unknown>).contentSize).toBeGreaterThan(500);
  });
});
