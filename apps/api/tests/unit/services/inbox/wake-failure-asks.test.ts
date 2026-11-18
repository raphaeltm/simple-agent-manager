/**
 * A failed chat wake is one open `asks` error item (inbox slice E), and the chat list reads it
 * back as the `wake_failed` attention the web app already renders (`readOpenQuestionAttention`,
 * `preferAttention`). Real SQL engine (`.claude/rules/28`); every attack case has an owner control.
 */
import { closeChatErrorAsksForHumanMessage } from '@simple-agent-manager/project-data/internal/do/question-asks';
import { preferAttention, readOpenQuestionAttention } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { createSchemaTables, createSqliteD1 } from '../../../helpers/sqlite-d1';

const NOW = 1_800_000_000_000;
let sqlite: Database.Database;
let db: D1Database;

function ask(
  id: string,
  row: Partial<{
    project: string;
    session: string;
    kind: string;
    status: string;
    dedupe: string | null;
    createdAt: number;
  }> = {}
) {
  const session = row.session ?? 'chat-1';
  sqlite
    .prepare(
      `INSERT INTO asks (id, project_id, assignee_kind, assignee_user_id, kind, blocking, title,
          body_md, source_session_id, source_task_id, status, dedupe_key, created_at, updated_at)
       VALUES (?, ?, 'user', 'owner', ?, ?, 'Couldn''t wake “Ship”', 'SAM could not restart the agent.',
          ?, 'task-1', ?, ?, ?, ?)`
    )
    .run(
      id,
      row.project ?? 'p1',
      row.kind ?? 'error',
      // A request_human_input question is blocking (slice D); error items never are.
      (row.kind ?? 'error') === 'question' ? 1 : 0,
      session,
      row.status ?? 'open',
      row.dedupe === undefined ? `error:wake:${session}` : row.dedupe,
      row.createdAt ?? 1_000,
      row.createdAt ?? 1_000
    );
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.asks]);
  db = createSqliteD1(sqlite) as unknown as D1Database;
});

describe('a failed wake reads back as the chat’s wake_failed attention', () => {
  it('returns the open wake item in the marker shape the web app reads', async () => {
    ask('w1');
    const result = await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW });
    expect(result.get('chat-1')).toEqual({
      markerId: 'w1',
      kind: 'wake_failed',
      source: 'session_wake',
      createdAt: 1_000,
      expiresAt: null,
      reason: 'SAM could not restart the agent.',
      options: [],
      category: null,
      interactionId: null,
      interactionKind: null,
    });
  });

  it('a question in the same chat wins over the wake failure', async () => {
    ask('w1', { createdAt: 5_000 });
    ask('q1', { kind: 'question', dedupe: null, createdAt: 1_000 });
    const result = await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW });
    expect(result.get('chat-1')).toMatchObject({ markerId: 'q1', kind: 'needs_input' });
  });

  it('leaves out closed wake items and other error items (controls)', async () => {
    ask('done', { status: 'done', dedupe: null });
    ask('sleep', { session: 'chat-2', dedupe: 'error:sleep:chat-2' });
    ask('task', { session: 'chat-3', dedupe: 'error:task:task-9' });
    ask('open', { session: 'chat-4' });
    const result = await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW });
    expect([...result.keys()]).toEqual(['chat-4']);
  });

  it('is bound to the project (attack) and still read for its own (owner control)', async () => {
    ask('foreign', { project: 'p2' });
    expect((await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW })).size).toBe(0);
    ask('mine');
    expect(
      (await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW })).get('chat-1')
    ).toMatchObject({ markerId: 'mine' });
  });

  it('a pending permission marker beats a wake failure; a newer other marker wins by time', () => {
    const wake = {
      markerId: 'w1',
      kind: 'wake_failed' as const,
      source: 'session_wake' as const,
      createdAt: 2_000,
      expiresAt: null,
      reason: null,
      options: [],
      category: null,
      interactionId: null,
      interactionKind: null,
    };
    const permission = { markerId: 'm1', kind: 'needs_input', createdAt: 1_000 };
    expect(preferAttention(permission, wake)).toBe(permission);
    const olderLimit = { markerId: 'm2', kind: 'provider_limit_blocked', createdAt: 1_000 };
    expect(preferAttention(olderLimit, wake)).toBe(wake);
    const newerLimit = { markerId: 'm3', kind: 'provider_limit_blocked', createdAt: 3_000 };
    expect(preferAttention(newerLimit, wake)).toBe(newerLimit);
    expect(preferAttention(null, wake)).toBe(wake);
  });
});

describe('a person writing in the chat closes its system error items', () => {
  it('closes this chat’s wake, sleep and delivery items, open or archived, and nothing else', async () => {
    ask('wake');
    ask('sleep', { dedupe: 'error:sleep:chat-1', status: 'archived' });
    ask('delivery', { dedupe: 'error:delivery:chat-1' });
    ask('task', { dedupe: 'error:task:task-1' });
    ask('other-chat', { session: 'chat-2' });
    ask('other-project', { project: 'p2' });

    const closed = await closeChatErrorAsksForHumanMessage({ DATABASE: db } as never, {
      projectId: 'p1',
      sessionId: 'chat-1',
    });
    expect(closed).toBe(3);
    const rows = Object.fromEntries(
      (
        sqlite.prepare('SELECT id, status, dedupe_key, notified_at FROM asks').all() as Array<{
          id: string;
          status: string;
          dedupe_key: string | null;
          notified_at: number | null;
        }>
      ).map((row) => [row.id, row])
    );
    expect(rows.wake).toMatchObject({ status: 'done', dedupe_key: null });
    expect(rows.wake!.notified_at).not.toBeNull();
    expect(rows.sleep).toMatchObject({ status: 'archived', dedupe_key: null });
    expect(rows.delivery).toMatchObject({ status: 'done', dedupe_key: null });
    // Controls: the task's item, another chat and another project are untouched.
    expect(rows.task).toMatchObject({ status: 'open', dedupe_key: 'error:task:task-1' });
    expect(rows['other-chat']).toMatchObject({ status: 'open' });
    expect(rows['other-project']).toMatchObject({ status: 'open' });
    // The chat no longer shows "Wake failed".
    expect((await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW })).has('chat-1')).toBe(
      false
    );
  });
});
