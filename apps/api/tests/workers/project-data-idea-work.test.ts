/**
 * The batched Ideas-list read, driven through the real ProjectData Durable Object.
 *
 * It has to run here rather than against a stub. The read is four joined queries over
 * `resource_links`, `chat_sessions`, `session_attention_markers` and `idea_updates`, and the
 * things most likely to be wrong in them — a `json_each` id list, a strength filter, an
 * expiry predicate, a `ROW_NUMBER()` cap — are exactly what a mock `.where()` evaluates as
 * nothing (rules 28, 65).
 *
 * Links are written the way production writes them: `recordResourceLink`, which is what
 * `operations/link-write.ts` calls (rule 62). The legacy `linkSessionIdea` is deliberately
 * not used — nothing calls it since T1, and a test that used it would pass while the feature
 * showed an empty list.
 */
import type { IdeaUpdateNote, LinkRelation } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import {
  getIdeaWorkSnapshots,
  IDEA_NEEDS_INPUT_MARKER_KIND,
  type IdeaWorkLinkCaps,
} from '../../src/durable-objects/project-data/idea-work';
import type { LinkLimits, LinkWrite } from '../../src/durable-objects/project-data/links';

/** The production defaults from the admin settings registry. */
const CAPS: IdeaWorkLinkCaps = { perTargetCap: 50, maxTargets: 100 };

const LIMITS: LinkLimits = {
  touchIntervalMs: 0,
  weakPerTarget: 50,
  weakCleanupBatchSize: 50,
  projectCap: 100_000,
  storageHighWaterBytes: 1_000_000_000,
};

interface Snapshot {
  ideaId: string;
  sessions: Array<{
    sessionId: string;
    topic: string | null;
    sessionStatus: string;
    sessionTaskId: string | null;
    relations: LinkRelation[];
    strong: boolean;
  }>;
  needsInput: Array<{ sessionId: string; question: string | null; askedAt: number }>;
  fileIds: string[];
  pullRequestUrls: string[];
  updates: number;
  truncated: { sessions: boolean; files: boolean; pullRequests: boolean };
}

interface IdeaWorkTestDouble {
  createSession(
    workspaceId: string | null,
    topic: string | null,
    taskId?: string | null
  ): Promise<string>;
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
  recordResourceLink(input: LinkWrite, limits: LinkLimits): Promise<unknown>;
  addIdeaUpdate(input: IdeaUpdateNote, minAgentIntervalMs: number): Promise<unknown>;
  getIdeaWorkSnapshots(
    ideaIds: string[],
    caps: IdeaWorkLinkCaps
  ): Promise<Record<string, Snapshot>>;
}

function getStub(projectId: string): DurableObjectStub<IdeaWorkTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as unknown as DurableObjectStub<IdeaWorkTestDouble>;
}

/** Links a chat to an idea the way the chat-ideas route and the auto-link tools do. */
async function link(
  stub: DurableObjectStub<IdeaWorkTestDouble>,
  sessionId: string,
  ideaId: string,
  relation: LinkRelation,
  origin: LinkWrite['origin'] = 'explicit'
): Promise<void> {
  await stub.recordResourceLink(
    {
      sourceKind: 'session',
      sourceId: sessionId,
      targetKind: 'idea',
      targetId: ideaId,
      relation,
      origin,
      context: null,
    },
    LIMITS
  );
}

async function linkAsset(
  stub: DurableObjectStub<IdeaWorkTestDouble>,
  source: { kind: LinkWrite['sourceKind']; id: string },
  target: { kind: 'file' | 'pr'; id: string },
  relation: LinkRelation
): Promise<void> {
  await stub.recordResourceLink(
    {
      sourceKind: source.kind,
      sourceId: source.id,
      targetKind: target.kind,
      targetId: target.id,
      relation,
      origin: 'explicit',
      context: null,
    },
    LIMITS
  );
}

describe('getIdeaWorkSnapshots', () => {
  it('answers for several ideas at once, and keys the answer by idea', async () => {
    const stub = getStub('idea-work-batched');
    const first = await stub.createSession(null, 'Building retries', 'task-build');
    const second = await stub.createSession(null, 'Research', 'task-research');
    const other = await stub.createSession(null, 'Something else', 'task-other');
    await link(stub, first, 'idea-a', 'works_on');
    await link(stub, second, 'idea-a', 'linked');
    await link(stub, other, 'idea-b', 'linked');

    const snapshots = await stub.getIdeaWorkSnapshots(
      ['idea-a', 'idea-b', 'idea-never-linked'],
      CAPS
    );

    expect(Object.keys(snapshots).sort()).toEqual(['idea-a', 'idea-b', 'idea-never-linked']);
    expect(snapshots['idea-a']?.sessions).toHaveLength(2);
    expect(snapshots['idea-b']?.sessions).toHaveLength(1);
    // An idea with nothing linked gets an empty entry, so no caller has to tell "absent"
    // from "nothing yet".
    expect(snapshots['idea-never-linked']).toEqual({
      ideaId: 'idea-never-linked',
      sessions: [],
      needsInput: [],
      fileIds: [],
      pullRequestUrls: [],
      updates: 0,
      truncated: { sessions: false, files: false, pullRequests: false },
    });
  });

  it('carries the chat’s topic, status and task so the list can say who is working', async () => {
    const stub = getStub('idea-work-fields');
    const sessionId = await stub.createSession('workspace-1', 'Building retries', 'task-build');
    await link(stub, sessionId, 'idea-a', 'works_on');

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
    expect(snapshots['idea-a']?.sessions[0]).toMatchObject({
      sessionId,
      topic: 'Building retries',
      sessionStatus: 'active',
      sessionTaskId: 'task-build',
      relations: ['works_on'],
      strong: true,
    });
  });

  it('reports a weak link as weak, and a chat with both relations as strong', async () => {
    const stub = getStub('idea-work-strength');
    const reader = await stub.createSession(null, 'Only read it', 'task-read');
    const both = await stub.createSession(null, 'Read it, then worked on it', 'task-both');
    await link(stub, reader, 'idea-a', 'read', 'auto');
    await link(stub, both, 'idea-a', 'read', 'auto');
    await link(stub, both, 'idea-a', 'works_on');

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
    const byId = new Map(snapshots['idea-a']?.sessions.map((s) => [s.sessionId, s]));
    // Weak and strong are decided by the relation rows, not assumed: the derivation drops
    // weak links, so getting this wrong would let a chat that merely read an idea move it.
    expect(byId.get(reader)).toMatchObject({ relations: ['read'], strong: false });
    expect(byId.get(both)?.strong).toBe(true);
    expect([...(byId.get(both)?.relations ?? [])].sort()).toEqual(['read', 'works_on']);
  });

  it('returns an unanswered question, and drops it once it is resolved', async () => {
    const stub = getStub('idea-work-question');
    const sessionId = await stub.createSession(null, 'Asking', 'task-ask');
    await link(stub, sessionId, 'idea-a', 'works_on');
    await stub.createAttentionMarker({
      sessionId,
      taskId: 'task-ask',
      workspaceId: null,
      kind: IDEA_NEEDS_INPUT_MARKER_KIND,
      source: 'request_human_input',
      reason: 'Cap retries at 3 days?',
      expiresAt: Date.now() + 3_600_000,
    });

    const asking = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
    expect(asking['idea-a']?.needsInput).toHaveLength(1);
    expect(asking['idea-a']?.needsInput[0]).toMatchObject({
      sessionId,
      question: 'Cap retries at 3 days?',
    });

    // Answered the way a person answers: by replying in the chat. Resolving the marker
    // directly would prove the query filters `resolved_at`, not that an answer clears it.
    await stub.persistMessage(sessionId, 'user', 'Yes, cap it at 3 days.', null);

    const answered = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
    expect(answered['idea-a']?.needsInput).toHaveLength(0);
  });

  it('ignores a question asked in a chat that only read the idea', async () => {
    const stub = getStub('idea-work-weak-question');
    const reader = await stub.createSession(null, 'Only read it', 'task-read');
    const worker = await stub.createSession(null, 'Working on it', 'task-work');
    await link(stub, reader, 'idea-a', 'discusses', 'auto');
    await link(stub, worker, 'idea-a', 'works_on');
    await stub.createAttentionMarker({
      sessionId: reader,
      taskId: 'task-read',
      workspaceId: null,
      kind: IDEA_NEEDS_INPUT_MARKER_KIND,
      source: 'request_human_input',
      reason: 'a question about something else',
      expiresAt: Date.now() + 3_600_000,
    });

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
    // The absence is paired with a positive assertion, so a crashed read cannot pass this
    // (rule 62): both chats are still listed, only the weak one's question is dropped.
    expect(snapshots['idea-a']?.sessions).toHaveLength(2);
    expect(snapshots['idea-a']?.needsInput).toHaveLength(0);
  });

  /**
   * The expiry predicate, with the clock injected.
   *
   * It cannot be driven by waiting: the Durable Object's own attention-expiry section
   * DEFERS an unexpired marker whose question was never delivered (rule 47), so a marker
   * seeded "an hour in the past" is rewritten to a future expiry by the first alarm tick
   * and the assertion inverts. `getIdeaWorkSnapshots` takes `now` because production
   * passes `Date.now()`; reading the predicate at a chosen instant is the same code path
   * with a different clock, not a hand-fed answer.
   */
  it('ignores a marker that has expired at the instant it is read', async () => {
    const readAt = 2_000_000_000_000;
    await runInDurableObject(
      env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName('idea-work-expiry')),
      async (instance: ProjectData) => {
        const expiring = await instance.createSession(null, 'Expiring ask', 'task-1');
        const forever = await instance.createSession(null, 'Live ask', 'task-2');
        for (const sessionId of [expiring, forever]) {
          instance.recordResourceLink(
            {
              sourceKind: 'session',
              sourceId: sessionId,
              targetKind: 'idea',
              targetId: 'idea-a',
              relation: 'works_on',
              origin: 'explicit',
              context: null,
            },
            LIMITS
          );
        }
        await instance.createAttentionMarker({
          sessionId: expiring,
          taskId: 'task-1',
          workspaceId: null,
          kind: IDEA_NEEDS_INPUT_MARKER_KIND,
          source: 'request_human_input',
          reason: 'stale question',
          expiresAt: readAt - 1,
        });
        await instance.createAttentionMarker({
          sessionId: forever,
          taskId: 'task-2',
          workspaceId: null,
          kind: IDEA_NEEDS_INPUT_MARKER_KIND,
          source: 'request_human_input',
          reason: 'live question',
          expiresAt: null,
        });

        const sql = (instance as unknown as { sql: SqlStorage }).sql;
        const snapshots = getIdeaWorkSnapshots(sql, ['idea-a'], CAPS, readAt);
        // Both chats are still listed, so a read that returned nothing cannot pass.
        expect(snapshots['idea-a']?.sessions).toHaveLength(2);
        expect(snapshots['idea-a']?.needsInput.map((m) => m.question)).toEqual(['live question']);
      }
    );
  });

  it('ignores a marker of another kind: only an unanswered question counts', async () => {
    const stub = getStub('idea-work-other-kind');
    const sessionId = await stub.createSession(null, 'Checking in', 'task-1');
    await link(stub, sessionId, 'idea-a', 'works_on');
    await stub.createAttentionMarker({
      sessionId,
      taskId: 'task-1',
      workspaceId: null,
      kind: 'reconciliation_checkin',
      source: 'reconciliation',
      reason: 'are you there?',
      expiresAt: null,
    });

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
    expect(snapshots['idea-a']?.sessions).toHaveLength(1);
    expect(snapshots['idea-a']?.needsInput).toHaveLength(0);
  });

  it('does not leak another idea’s chats into the ideas asked for', async () => {
    const stub = getStub('idea-work-scope');
    const mine = await stub.createSession(null, 'Mine', 'task-mine');
    const theirs = await stub.createSession(null, 'Theirs', 'task-theirs');
    await link(stub, mine, 'idea-a', 'works_on');
    await link(stub, theirs, 'idea-z', 'works_on');

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
    expect(Object.keys(snapshots)).toEqual(['idea-a']);
    expect(snapshots['idea-a']?.sessions).toHaveLength(1);
  });

  it('asks for nothing when given nothing', async () => {
    const stub = getStub('idea-work-empty');
    expect(await stub.getIdeaWorkSnapshots([], CAPS)).toEqual({});
  });

  describe('what an idea owns', () => {
    it('collects its own files and pull requests, and its strong chats’', async () => {
      const stub = getStub('idea-work-assets');
      const worker = await stub.createSession(null, 'Working on it', 'task-work');
      await link(stub, worker, 'idea-a', 'works_on');
      await linkAsset(
        stub,
        { kind: 'idea', id: 'idea-a' },
        { kind: 'file', id: 'file-plan' },
        'linked'
      );
      await linkAsset(
        stub,
        { kind: 'session', id: worker },
        { kind: 'file', id: 'file-output' },
        'uploaded'
      );
      await linkAsset(
        stub,
        { kind: 'session', id: worker },
        { kind: 'pr', id: 'https://github.com/o/r/pull/7' },
        'opened'
      );

      const snapshots = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
      expect(snapshots['idea-a']?.fileIds.sort()).toEqual(['file-output', 'file-plan']);
      expect(snapshots['idea-a']?.pullRequestUrls).toEqual(['https://github.com/o/r/pull/7']);
    });

    it('never pulls in the files or pull requests of a chat that only read it', async () => {
      const stub = getStub('idea-work-weak-assets');
      const reader = await stub.createSession(null, 'Only read it', 'task-read');
      const worker = await stub.createSession(null, 'Working on it', 'task-work');
      await link(stub, reader, 'idea-a', 'viewed', 'auto');
      await link(stub, worker, 'idea-a', 'works_on');
      await linkAsset(
        stub,
        { kind: 'session', id: reader },
        { kind: 'file', id: 'file-theirs' },
        'uploaded'
      );
      await linkAsset(
        stub,
        { kind: 'session', id: worker },
        { kind: 'file', id: 'file-mine' },
        'uploaded'
      );

      const snapshots = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
      // The owner control sits beside the attack case: a read that returned nothing at all
      // would also satisfy "the weak chat's file is absent".
      expect(snapshots['idea-a']?.fileIds).toEqual(['file-mine']);
    });

    it('counts a file two chats both uploaded once', async () => {
      const stub = getStub('idea-work-asset-dedupe');
      const first = await stub.createSession(null, 'First', 'task-1');
      const second = await stub.createSession(null, 'Second', 'task-2');
      await link(stub, first, 'idea-a', 'works_on');
      await link(stub, second, 'idea-a', 'works_on');
      await linkAsset(
        stub,
        { kind: 'session', id: first },
        { kind: 'file', id: 'file-shared' },
        'uploaded'
      );
      await linkAsset(
        stub,
        { kind: 'session', id: second },
        { kind: 'file', id: 'file-shared' },
        'replaced'
      );

      const snapshots = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
      expect(snapshots['idea-a']?.fileIds).toEqual(['file-shared']);
    });

    it('says the file count is a minimum when it hit the per-idea cap', async () => {
      const stub = getStub('idea-work-asset-cap');
      const worker = await stub.createSession(null, 'Busy', 'task-busy');
      await link(stub, worker, 'idea-a', 'works_on');
      for (let index = 0; index < 4; index += 1) {
        await linkAsset(
          stub,
          { kind: 'session', id: worker },
          { kind: 'file', id: `file-${index}` },
          'uploaded'
        );
      }

      const capped = await stub.getIdeaWorkSnapshots(['idea-a'], {
        perTargetCap: 3,
        maxTargets: 100,
      });
      expect(capped['idea-a']?.fileIds).toHaveLength(3);
      expect(capped['idea-a']?.truncated.files).toBe(true);

      const whole = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
      expect(whole['idea-a']?.fileIds).toHaveLength(4);
      expect(whole['idea-a']?.truncated.files).toBe(false);
    });

    /*
     * The cap counts link ROWS, not distinct chats, and `truncated.sessions` has to agree with
     * it. One chat can hold several relations to one idea — `read` and `works_on` are separate
     * rows — which the snapshot folds into a single session entry. Counting the folded entries
     * undercounts against the cap: here 3 rows from 2 chats reach a cap of 3, but only 2
     * sessions come back, so the old `byId.size >= cap` reported NOT truncated and the list
     * published "2 chats" as exact. `IdeaCounts.atLeast` exists precisely to say "2+" there.
     */
    it('says the chat count is a minimum when relations, not chats, exhausted the cap', async () => {
      const stub = getStub('idea-work-session-row-cap');
      const first = await stub.createSession(null, 'First', 'task-first');
      const second = await stub.createSession(null, 'Second', 'task-second');
      // Three ROWS across two chats: the first chat contributes two relations.
      await link(stub, first, 'idea-a', 'works_on');
      await link(stub, first, 'idea-a', 'read');
      await link(stub, second, 'idea-a', 'works_on');

      const capped = await stub.getIdeaWorkSnapshots(['idea-a'], {
        perTargetCap: 3,
        maxTargets: 100,
      });
      // Fewer sessions than the cap, because two rows folded into one.
      expect(capped['idea-a']?.sessions.length).toBeLessThan(3);
      expect(capped['idea-a']?.truncated.sessions).toBe(true);

      // The control: the same links under a cap that cannot bite are NOT truncated, so the
      // assertion above is about the cap rather than about relations existing at all.
      const whole = await stub.getIdeaWorkSnapshots(['idea-a'], CAPS);
      expect(whole['idea-a']?.truncated.sessions).toBe(false);
    });
  });

  it('counts the notes on each idea, and omits deleted ones', async () => {
    const stub = getStub('idea-work-updates');
    const sessionId = await stub.createSession(null, 'Working on it', 'task-work');
    await link(stub, sessionId, 'idea-a', 'works_on');
    for (const [index, body] of ['first note', 'second note'].entries()) {
      await stub.addIdeaUpdate(
        {
          id: `update-${index}`,
          ideaId: 'idea-a',
          authorKind: 'user',
          authorUserId: 'user-1',
          authorName: 'Someone',
          sessionId: null,
          sessionTopic: null,
          body,
          quote: null,
          createdAt: new Date(1_700_000_000_000 + index).toISOString(),
          editedAt: null,
        },
        0
      );
    }

    const snapshots = await stub.getIdeaWorkSnapshots(['idea-a', 'idea-b'], CAPS);
    expect(snapshots['idea-a']?.updates).toBe(2);
    expect(snapshots['idea-b']?.updates).toBe(0);
  });

  /**
   * More ideas than one link query may ask about. The chunk boundary is the platform's, not
   * SQLite's, so no fixture size reproduces it on a different engine — this has to run in
   * workerd (rule 69).
   */
  it('reads more ideas than one link query may ask about', async () => {
    const stub = getStub('idea-work-bind-limit');
    const ideaIds = Array.from({ length: 201 }, (_, index) => `idea-${index}`);
    const sessionId = await stub.createSession(null, 'Linked to the last one', 'task-1');
    await link(stub, sessionId, ideaIds[ideaIds.length - 1]!, 'works_on');

    const snapshots = await stub.getIdeaWorkSnapshots(ideaIds, CAPS);
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
        for (const sessionId of [good, 'broken']) {
          instance.recordResourceLink(
            {
              sourceKind: 'session',
              sourceId: sessionId,
              targetKind: 'idea',
              targetId: 'idea-a',
              relation: 'works_on',
              origin: 'explicit',
              context: null,
            },
            LIMITS
          );
        }

        const snapshots = getIdeaWorkSnapshots(sql, ['idea-a'], CAPS);
        expect(snapshots['idea-a']?.sessions).toHaveLength(1);
        expect(snapshots['idea-a']?.sessions[0]?.topic).toBe('Healthy chat');
      }
    );
  });
});
