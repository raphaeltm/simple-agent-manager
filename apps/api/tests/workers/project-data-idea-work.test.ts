/**
 * The batched Ideas-list read, driven through the real ProjectData Durable Object.
 *
 * It has to run here rather than against a stub: the queries join `chat_session_ideas`,
 * `chat_sessions` and `session_attention_markers`, and an `IN (?, …)` list and an expiry
 * predicate are exactly the things a mock `.where()` would evaluate as nothing (rules 28, 65).
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import {
  getIdeaWorkSnapshots,
  IDEA_NEEDS_INPUT_MARKER_KIND,
} from '../../src/durable-objects/project-data/idea-work';

interface IdeaWorkTestDouble {
  createSession(
    workspaceId: string | null,
    topic: string | null,
    taskId?: string | null
  ): Promise<string>;
  linkSessionIdea(sessionId: string, taskId: string, context: string | null): Promise<void>;
  persistMessage(
    sessionId: string,
    role: string,
    content: string,
    toolMetadata: string | null
  ): Promise<string>;
  createAttentionMarker(opts: {
    sessionId: string;
    taskId: string | null;
    workspaceId: string | null;
    kind: string;
    source: string;
    reason?: string | null;
    expiresAt?: number | null;
  }): Promise<{ id: string }>;
  getIdeaWorkSnapshots(
    ideaIds: string[]
  ): Promise<Record<string, { ideaId: string; sessions: unknown[]; needsInput: unknown[] }>>;
}

function getStub(projectId: string): DurableObjectStub<IdeaWorkTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as unknown as DurableObjectStub<IdeaWorkTestDouble>;
}

describe('getIdeaWorkSnapshots', () => {
  it('answers for several ideas at once, and keys the answer by idea', async () => {
    const stub = getStub('idea-work-batched');
    const first = await stub.createSession(null, 'Building retries', 'task-build');
    const second = await stub.createSession(null, 'Research', 'task-research');
    const other = await stub.createSession(null, 'Something else', 'task-other');
    await stub.linkSessionIdea(first, 'idea-a', 'works on it');
    await stub.linkSessionIdea(second, 'idea-a', 'researched it');
    await stub.linkSessionIdea(other, 'idea-b', null);

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a', 'idea-b', 'idea-never-linked']);

    expect(Object.keys(snapshots).sort()).toEqual(['idea-a', 'idea-b', 'idea-never-linked']);
    expect(snapshots['idea-a']?.sessions).toHaveLength(2);
    expect(snapshots['idea-b']?.sessions).toHaveLength(1);
    // An idea with nothing linked gets an empty entry, so no caller has to tell "absent"
    // from "nothing yet".
    expect(snapshots['idea-never-linked']).toEqual({
      ideaId: 'idea-never-linked',
      sessions: [],
      needsInput: [],
    });
  });

  it('carries the chat’s topic, status and task so the list can say who is working', async () => {
    const stub = getStub('idea-work-fields');
    const sessionId = await stub.createSession('workspace-1', 'Building retries', 'task-build');
    await stub.linkSessionIdea(sessionId, 'idea-a', null);

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a']);
    expect(snapshots['idea-a']?.sessions[0]).toMatchObject({
      sessionId,
      topic: 'Building retries',
      sessionStatus: 'active',
      sessionTaskId: 'task-build',
    });
  });

  it('returns an unanswered question, and drops it once it is resolved', async () => {
    const stub = getStub('idea-work-question');
    const sessionId = await stub.createSession(null, 'Asking', 'task-ask');
    await stub.linkSessionIdea(sessionId, 'idea-a', null);
    await stub.createAttentionMarker({
      sessionId,
      taskId: 'task-ask',
      workspaceId: null,
      kind: IDEA_NEEDS_INPUT_MARKER_KIND,
      source: 'request_human_input',
      reason: 'Cap retries at 3 days?',
      expiresAt: Date.now() + 3_600_000,
    });

    const asking = await stub.getIdeaWorkSnapshots(['idea-a']);
    expect(asking['idea-a']?.needsInput).toHaveLength(1);
    expect(asking['idea-a']?.needsInput[0]).toMatchObject({
      sessionId,
      question: 'Cap retries at 3 days?',
    });

    // Answered the way a person answers: by replying in the chat. Resolving the marker
    // directly would prove the query filters `resolved_at`, not that an answer clears it.
    await stub.persistMessage(sessionId, 'user', 'Yes, cap it at 3 days.', null);

    const answered = await stub.getIdeaWorkSnapshots(['idea-a']);
    expect(answered['idea-a']?.needsInput).toHaveLength(0);
  });

  it('ignores a marker that has expired, and keeps one that has not', async () => {
    const stub = getStub('idea-work-expiry');
    const expired = await stub.createSession(null, 'Expired ask', 'task-1');
    const live = await stub.createSession(null, 'Live ask', 'task-2');
    await stub.linkSessionIdea(expired, 'idea-a', null);
    await stub.linkSessionIdea(live, 'idea-a', null);
    await stub.createAttentionMarker({
      sessionId: expired,
      taskId: 'task-1',
      workspaceId: null,
      kind: IDEA_NEEDS_INPUT_MARKER_KIND,
      source: 'request_human_input',
      // An hour in the past, not a second: workerd pins `Date.now()` to the last I/O, so the
      // Durable Object's clock can legitimately lag the test's by a little.
      reason: 'stale question',
      expiresAt: Date.now() - 3_600_000,
    });
    await stub.createAttentionMarker({
      sessionId: live,
      taskId: 'task-2',
      workspaceId: null,
      kind: IDEA_NEEDS_INPUT_MARKER_KIND,
      source: 'request_human_input',
      reason: 'live question',
      expiresAt: Date.now() + 3_600_000,
    });

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a']);
    expect(
      (snapshots['idea-a']?.needsInput as Array<{ question: string }>).map((m) => m.question)
    ).toEqual(['live question']);
  });

  it('ignores a marker of another kind: only an unanswered question counts', async () => {
    const stub = getStub('idea-work-other-kind');
    const sessionId = await stub.createSession(null, 'Checking in', 'task-1');
    await stub.linkSessionIdea(sessionId, 'idea-a', null);
    await stub.createAttentionMarker({
      sessionId,
      taskId: 'task-1',
      workspaceId: null,
      kind: 'reconciliation_checkin',
      source: 'reconciliation',
      reason: 'are you there?',
      expiresAt: null,
    });

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a']);
    expect(snapshots['idea-a']?.needsInput).toHaveLength(0);
  });

  it('does not leak another idea’s chats into the ideas asked for', async () => {
    const stub = getStub('idea-work-scope');
    const mine = await stub.createSession(null, 'Mine', 'task-mine');
    const theirs = await stub.createSession(null, 'Theirs', 'task-theirs');
    await stub.linkSessionIdea(mine, 'idea-a', null);
    await stub.linkSessionIdea(theirs, 'idea-z', null);

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a']);
    expect(Object.keys(snapshots)).toEqual(['idea-a']);
    expect(snapshots['idea-a']?.sessions).toHaveLength(1);
  });

  it('asks for nothing when given nothing', async () => {
    const stub = getStub('idea-work-empty');
    expect(await stub.getIdeaWorkSnapshots([])).toEqual({});
  });

  /**
   * More ideas than the platform's bound-parameter ceiling allows in one statement. The
   * ceiling belongs to Cloudflare, not SQLite, so no fixture size reproduces it on a
   * different engine — this has to run in workerd (rule 69).
   */
  it('reads more ideas than fit in one statement’s bind list', async () => {
    const stub = getStub('idea-work-bind-limit');
    const ideaIds = Array.from({ length: 201 }, (_, index) => `idea-${index}`);
    const sessionId = await stub.createSession(null, 'Linked to the last one', 'task-1');
    await stub.linkSessionIdea(sessionId, ideaIds[ideaIds.length - 1]!, null);

    const snapshots = await stub.getIdeaWorkSnapshots(ideaIds);
    expect(Object.keys(snapshots)).toHaveLength(201);
    expect(snapshots[ideaIds[ideaIds.length - 1]!]?.sessions).toHaveLength(1);
  });

  it('skips a malformed row instead of failing the whole read', async () => {
    // Driven against the module with the DO's own SqlStorage, because the corruption has to
    // be written behind the linking API (rule 50: one bad row must not fail a list).
    await runInDurableObject(
      env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName('idea-work-fault')),
      async (instance: ProjectData) => {
        const good = await instance.createSession(null, 'Healthy chat', 'task-good');
        await instance.linkSessionIdea(good, 'idea-a', null);
        const sql = (instance as unknown as { sql: SqlStorage }).sql;
        // A chat row whose `updated_at` is not a number. SQLite's INTEGER affinity keeps a
        // non-numeric string as text, which is what a legacy or partially written row looks
        // like to the row parser.
        sql.exec(
          `INSERT INTO chat_sessions (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at, task_id)
           VALUES ('broken', NULL, 'Broken chat', 'active', 0, ?, ?, 'not-a-number', 'task-broken')`,
          Date.now(),
          Date.now()
        );
        sql.exec(
          `INSERT INTO chat_session_ideas (session_id, task_id, context, created_at)
           VALUES ('broken', 'idea-a', NULL, ?)`,
          Date.now()
        );

        const snapshots = getIdeaWorkSnapshots(sql, ['idea-a']);
        expect(snapshots['idea-a']?.sessions).toHaveLength(1);
        expect(snapshots['idea-a']?.sessions[0]?.topic).toBe('Healthy chat');
      }
    );
  });
});
