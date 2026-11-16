/**
 * The shared reads of open questions held in D1 `asks` (inbox slice G,
 * `packages/worker-core/src/question-asks.ts`) on a real SQL engine (`.claude/rules/28`): every
 * mode is bound to its project, each attack case has an owner control, and one unreadable row
 * never hides the others (`.claude/rules/50`).
 */
import {
  hasOpenQuestionAsk,
  preferAttention,
  readOpenQuestionAttention,
} from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { createSchemaTables, createSqliteD1 } from '../../../helpers/sqlite-d1';

const NOW = 1_800_000_000_000;
let sqlite: Database.Database;
let db: D1Database;

function ask(
  id: string,
  overrides: Partial<{
    project: string;
    session: string | null;
    task: string | null;
    assignee: string;
    status: string;
    kind: string;
    expiresAt: number | null;
    createdAt: number;
    spec: string | null;
  }> = {}
) {
  sqlite
    .prepare(
      `INSERT INTO asks (id, project_id, assignee_kind, assignee_user_id, kind, blocking, title,
          body_md, answer_spec_json, category, source_session_id, source_task_id, status,
          expires_at, created_at, updated_at)
       VALUES (?, ?, 'user', ?, ?, 1, 'Pick', 'Pick a region.', ?, 'decision', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      overrides.project ?? 'p1',
      overrides.assignee ?? 'owner',
      overrides.kind ?? 'question',
      overrides.spec === undefined
        ? '{"type":"options","options":["eu","us"],"allowText":false}'
        : overrides.spec,
      overrides.session === undefined ? 'chat-1' : overrides.session,
      overrides.task === undefined ? 'task-1' : overrides.task,
      overrides.status ?? 'open',
      overrides.expiresAt === undefined ? NOW + 60_000 : overrides.expiresAt,
      overrides.createdAt ?? 1_000,
      overrides.createdAt ?? 1_000
    );
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.asks]);
  db = createSqliteD1(sqlite) as unknown as D1Database;
});

describe('readOpenQuestionAttention', () => {
  it('returns each chat’s newest open question as an attention summary', async () => {
    ask('old', { createdAt: 1_000 });
    ask('new', { createdAt: 2_000 });
    const result = await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW });
    expect([...result.keys()]).toEqual(['chat-1']);
    expect(result.get('chat-1')).toEqual({
      markerId: 'new',
      kind: 'needs_input',
      source: 'request_human_input',
      createdAt: 2_000,
      expiresAt: NOW + 60_000,
      reason: 'Pick a region.',
      options: ['eu', 'us'],
      category: 'decision',
      interactionId: null,
      interactionKind: null,
    });
  });

  it('leaves out closed, expired and non-question asks (controls)', async () => {
    ask('answered', { status: 'answered' });
    ask('expired', { expiresAt: NOW - 1, session: 'chat-2' });
    ask('review', { kind: 'review', session: 'chat-3' });
    ask('open', { session: 'chat-4' });
    const result = await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW });
    expect([...result.keys()]).toEqual(['chat-4']);
  });

  it('project mode: another project’s question with the same chat id is not read (attack + owner control)', async () => {
    ask('foreign', { project: 'p2' });
    expect((await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW })).size).toBe(0);
    ask('mine');
    expect(
      (await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW })).get('chat-1')
    ).toMatchObject({ markerId: 'mine' });
  });

  it('chat mode reads only the named chats of the project', async () => {
    ask('a', { session: 'chat-1' });
    ask('b', { session: 'chat-2' });
    ask('foreign', { project: 'p2', session: 'chat-3' });
    const result = await readOpenQuestionAttention(db, {
      projectId: 'p1',
      sessionIds: ['chat-2', 'chat-3'],
      now: NOW,
    });
    expect([...result.keys()]).toEqual(['chat-2']);
    expect(
      (await readOpenQuestionAttention(db, { projectId: 'p1', sessionIds: [], now: NOW })).size
    ).toBe(0);
  });

  it('cross-project mode binds each chat to its own project (attack + owner control)', async () => {
    ask('p1-chat-1', { project: 'p1', session: 'chat-1' });
    ask('p2-chat-2', { project: 'p2', session: 'chat-2' });
    // Attack: the pairs swap projects; neither question may be read.
    const swapped = await readOpenQuestionAttention(db, {
      chats: [
        { projectId: 'p2', sessionId: 'chat-1' },
        { projectId: 'p1', sessionId: 'chat-2' },
      ],
      now: NOW,
    });
    expect(swapped.size).toBe(0);
    const owned = await readOpenQuestionAttention(db, {
      chats: [
        { projectId: 'p1', sessionId: 'chat-1' },
        { projectId: 'p2', sessionId: 'chat-2' },
      ],
      now: NOW,
    });
    expect([...owned.keys()].sort()).toEqual(['chat-1', 'chat-2']);
  });

  it('assignee filter: another person’s question is not read', async () => {
    ask('theirs', { assignee: 'colleague' });
    expect(
      (await readOpenQuestionAttention(db, { projectId: 'p1', assigneeUserId: 'owner', now: NOW }))
        .size
    ).toBe(0);
    expect(
      (
        await readOpenQuestionAttention(db, {
          projectId: 'p1',
          assigneeUserId: 'colleague',
          now: NOW,
        })
      ).size
    ).toBe(1);
  });

  it('a malformed answer spec yields no options instead of hiding the question (rule 50)', async () => {
    ask('bad-spec', { spec: 'not json', session: 'chat-1' });
    ask('good', { session: 'chat-2' });
    const result = await readOpenQuestionAttention(db, { projectId: 'p1', now: NOW });
    expect(result.get('chat-1')).toMatchObject({ markerId: 'bad-spec', options: [] });
    expect(result.get('chat-2')).toMatchObject({ markerId: 'good' });
  });

  it('a failed read degrades to no questions instead of failing the caller', async () => {
    sqlite.exec('DROP TABLE asks');
    await expect(readOpenQuestionAttention(db, { projectId: 'p1', now: NOW })).resolves.toEqual(
      new Map()
    );
  });
});

describe('hasOpenQuestionAsk (the stalled-task guard)', () => {
  const probe = (
    overrides: Partial<{ projectId: string; sessionId: string; taskId: string }> = {}
  ) =>
    hasOpenQuestionAsk(db, {
      projectId: 'p1',
      sessionId: 'chat-1',
      taskId: 'task-1',
      now: NOW,
      ...overrides,
    });

  it('sees an open question of this chat and task', async () => {
    ask('q');
    await expect(probe()).resolves.toBe(true);
  });

  it.each([
    ['another project', { projectId: 'p2' }],
    ['another chat', { sessionId: 'chat-2' }],
    ['another task of the chat', { taskId: 'task-2' }],
  ])('does not see it from %s', async (_label, overrides) => {
    ask('q');
    await expect(probe(overrides)).resolves.toBe(false);
  });
});

describe('preferAttention', () => {
  const question = {
    markerId: 'ask',
    kind: 'needs_input' as const,
    source: 'request_human_input' as const,
    createdAt: 2_000,
    expiresAt: null,
    reason: 'q',
    options: [],
    category: null,
    interactionId: null,
    interactionKind: null,
  };
  it('a newer marker question wins; an older one, or any other marker, does not', () => {
    expect(preferAttention({ kind: 'needs_input', createdAt: 3_000 }, question)).toMatchObject({
      createdAt: 3_000,
    });
    expect(preferAttention({ kind: 'needs_input', createdAt: 1_000 }, question)).toBe(question);
    expect(preferAttention({ kind: 'wake_failed', createdAt: 9_000 }, question)).toBe(question);
    expect(preferAttention(null, undefined)).toBeNull();
  });
});
