/**
 * The Ideas list and idea page through the real Hono routes, a real SQLite engine and a
 * ProjectData stub that answers the batched link read the way the Durable Object does.
 *
 * This is the vertical slice the derivation tests cannot give: it proves the route reaches
 * `deriveIdeaStatus` with evidence collected from both stores, that the page's reads stay
 * batched as the idea count grows, and that one project cannot read or change another's
 * ideas. Each attack case has an owner control beside it.
 */
import type { LinkRelation } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

interface SnapshotSession {
  sessionId: string;
  topic: string | null;
  sessionStatus: string;
  sessionTaskId: string | null;
  lastActivityAt: number | null;
  relations: LinkRelation[];
  strong: boolean;
  linkedAt: number;
}

const mocks = vi.hoisted(() => ({
  userId: 'u1',
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
  getIdeaWorkSnapshots: vi.fn(),
  snapshotCalls: [] as string[][],
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => mocks.userId,
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/project-data', () => ({
  getIdeaWorkSnapshots: mocks.getIdeaWorkSnapshots,
}));

import { IDEA_PULL_REQUEST_REFRESH, ideaRoutes } from '../../../src/routes/ideas';

const BASE = 'https://api.test.example.com/api/projects';
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

interface IdeasListBody {
  items: Array<{
    ideaId: string;
    title: string;
    summary: string | null;
    derived: {
      state: string;
      needsYou: string | null;
      session: { sessionId: string; agentLabel: string | null } | null;
      pullRequest: Record<string, unknown> | null;
      note: string | null;
    };
    counts: {
      chats: number;
      pullRequests: number;
      files: number;
      updates: number;
      atLeast: string[];
    };
    filedByAgent: boolean;
    filedBy: string | null;
    viaConnector: string | null;
  }>;
  truncated: boolean;
  totals: { open: number; done: number; parked: number };
}

describe('ideas routes', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;
  let env: Env;
  let queries: string[];

  function seedIdea(
    id: string,
    overrides: {
      projectId?: string;
      title?: string;
      description?: string | null;
      status?: string;
      isIdea?: number;
      triggeredBy?: string;
      connectorClientName?: string | null;
      updatedAt?: string;
    } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, description, status, is_idea, priority,
           task_mode, dispatch_depth, created_by, created_at, updated_at, triggered_by,
           connector_client_name)
         VALUES (?, ?, 'u1', ?, ?, ?, ?, 0, 'task', 0, 'u1', '2026-10-15T00:00:00.000Z', ?, ?, ?)`
      )
      .run(
        id,
        overrides.projectId ?? 'p1',
        overrides.title ?? `Idea ${id}`,
        overrides.description ?? null,
        overrides.status ?? 'draft',
        overrides.isIdea ?? 1,
        overrides.updatedAt ?? '2026-10-20T00:00:00.000Z',
        overrides.triggeredBy ?? 'user',
        overrides.connectorClientName ?? null
      );
  }

  function seedWorkTask(
    id: string,
    overrides: {
      projectId?: string;
      status?: string;
      errorMessage?: string | null;
      outputPrUrl?: string | null;
      agentProfileHint?: string | null;
    } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, is_idea, priority, task_mode,
           dispatch_depth, created_by, created_at, updated_at, triggered_by, error_message,
           output_pr_url, agent_profile_hint)
         VALUES (?, ?, 'u1', 'work', ?, 0, 0, 'task', 0, 'u1', '2026-10-21T00:00:00.000Z',
                 '2026-10-21T00:00:00.000Z', 'user', ?, ?, ?)`
      )
      .run(
        id,
        overrides.projectId ?? 'p1',
        overrides.status ?? 'in_progress',
        overrides.errorMessage ?? null,
        overrides.outputPrUrl ?? null,
        overrides.agentProfileHint ?? null
      );
  }

  /** A project row, because pull request URLs are canonicalized against its repository. */
  function seedProject(id: string, repository: string) {
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, installation_id, name, repository, repo_provider,
           created_at, updated_at)
         VALUES (?, 'u1', 'inst-1', ?, ?, 'github', '2026-10-01', '2026-10-01')`
      )
      .run(id, id, repository);
  }

  /** Stored pull request state, as T2's webhook and refresh paths write it. */
  function seedPullRequestState(
    projectId: string,
    repository: string,
    number: number,
    overrides: {
      state?: 'open' | 'closed' | 'merged';
      isDraft?: number;
      title?: string | null;
      checksState?: string | null;
      mergedAt?: string | null;
      updatedAt?: string;
    } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO pull_requests (id, project_id, repository, number, url, state, is_draft,
           title, checks_state, merged_at, created_at, updated_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-20T00:00:00.000Z', ?, ?)`
      )
      .run(
        `pr-${projectId}-${number}`,
        projectId,
        repository,
        number,
        `https://github.com/${repository}/pull/${number}`,
        overrides.state ?? 'open',
        overrides.isDraft ?? 0,
        overrides.title ?? `PR ${number}`,
        overrides.checksState ?? null,
        overrides.mergedAt ?? null,
        overrides.updatedAt ?? '2026-10-22T00:00:00.000Z',
        overrides.updatedAt ?? '2026-10-22T00:00:00.000Z'
      );
  }

  function snapshot(
    ideaId: string,
    sessions: Partial<SnapshotSession>[],
    extra: {
      needsInput?: Array<{ sessionId: string; question: string | null; askedAt: number }>;
      fileIds?: string[];
      pullRequestUrls?: string[];
      updates?: number;
      truncated?: Partial<{ sessions: boolean; files: boolean; pullRequests: boolean }>;
    } = {}
  ) {
    return {
      [ideaId]: {
        ideaId,
        sessions: sessions.map((session, index) => ({
          sessionId: session.sessionId ?? `sess-${index}`,
          topic: session.topic ?? 'A chat',
          sessionStatus: session.sessionStatus ?? 'active',
          sessionTaskId: session.sessionTaskId ?? null,
          lastActivityAt: session.lastActivityAt ?? minutesAgo(5),
          // The link store's own answer: a chat is strong because a relation says so.
          relations: session.relations ?? ['works_on'],
          strong: session.strong ?? true,
          linkedAt: session.linkedAt ?? minutesAgo(60),
        })),
        needsInput: extra.needsInput ?? [],
        fileIds: extra.fileIds ?? [],
        pullRequestUrls: extra.pullRequestUrls ?? [],
        updates: extra.updates ?? 0,
        truncated: {
          sessions: false,
          files: false,
          pullRequests: false,
          ...(extra.truncated ?? {}),
        },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = 'u1';
    mocks.snapshotCalls = [];
    mocks.requireProjectAccess.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'p1' || projectId === 'p2') return { id: projectId, userId: 'u1' };
      throw Object.assign(new Error('Project not found'), {
        statusCode: 404,
        error: 'NOT_FOUND',
      });
    });
    mocks.requireProjectCapability.mockImplementation(mocks.requireProjectAccess);
    mocks.getIdeaWorkSnapshots.mockImplementation(
      async (_env: unknown, _projectId: string, ideaIds: readonly string[]) => {
        mocks.snapshotCalls.push([...ideaIds]);
        return {};
      }
    );

    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare(
        `INSERT INTO users (id, github_id, email, name, created_at, updated_at)
         VALUES ('u1', 'gh-u1', 'u1@test', 'U1', '2026-10-01', '2026-10-01')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO github_installations (id, user_id, installation_id, account_name, account_type,
           created_at, updated_at)
         VALUES ('inst-1', 'u1', '1', 'acme', 'User', '2026-10-01', '2026-10-01')`
      )
      .run();
    seedProject('p1', 'acme/payments');
    seedProject('p2', 'acme/other');
    queries = [];
    const d1 = createSqliteD1(sqlite);
    env = {
      DATABASE: {
        ...d1,
        prepare(sql: string) {
          queries.push(sql);
          return d1.prepare(sql);
        },
        batch: d1.batch.bind(d1),
      } as unknown as D1Database,
      BASE_DOMAIN: 'example.test',
    } as Env;

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects/:projectId/ideas', ideaRoutes);
  });

  afterEach(() => sqlite.close());

  const list = (projectId = 'p1') =>
    app.request(`${BASE}/${projectId}/ideas`, { method: 'GET' }, env);

  it('returns ideas with a derived state, a summary and counts', async () => {
    seedIdea('idea-1', {
      title: 'Retry failed webhook deliveries',
      description: '# Plan\n\nRetry with exponential backoff for up to 3 days.',
    });
    seedWorkTask('work-1', { status: 'in_progress', agentProfileHint: 'prof-opus' });
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, created_at, updated_at)
         VALUES ('prof-opus', 'p1', 'u1', 'Opus 5.5', 'claude-code', '2026-10-01', '2026-10-01')`
      )
      .run();
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [{ sessionId: 'sess-a', sessionTaskId: 'work-1', topic: 'Building it' }])
    );

    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as IdeasListBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      ideaId: 'idea-1',
      title: 'Retry failed webhook deliveries',
      summary: 'Plan',
      filedByAgent: false,
    });
    expect(body.items[0]?.derived.state).toBe('working');
    expect(body.items[0]?.derived.session).toMatchObject({
      sessionId: 'sess-a',
      agentLabel: 'Opus 5.5',
    });
    expect(body.items[0]?.counts.chats).toBe(1);
    expect(body.totals).toEqual({ open: 1, done: 0, parked: 0 });
  });

  it('derives a question from an unanswered marker, and marks it as needing you', async () => {
    seedIdea('idea-1');
    seedWorkTask('work-1', { status: 'in_progress' });
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [{ sessionId: 'sess-a', sessionTaskId: 'work-1' }], {
        needsInput: [
          { sessionId: 'sess-a', question: 'Cap retries at 3 days?', askedAt: minutesAgo(2) },
        ],
      })
    );

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.derived.state).toBe('question');
    expect(body.items[0]?.derived.needsYou).toBe('question');
    expect(body.items[0]?.derived.note).toBe('Cap retries at 3 days?');
  });

  it('derives stuck from a failed task, with the failure the task recorded', async () => {
    seedIdea('idea-1');
    seedWorkTask('work-1', { status: 'failed', errorMessage: 'the suite went red' });
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [
        { sessionId: 'sess-a', sessionTaskId: 'work-1', sessionStatus: 'stopped' },
      ])
    );

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.derived.state).toBe('stuck');
    expect(body.items[0]?.derived.note).toBe('the suite went red');
  });

  it('counts the pull requests an idea’s work produced, from both sources', async () => {
    seedIdea('idea-1');
    seedWorkTask('work-1', {
      status: 'completed',
      outputPrUrl: 'https://github.com/acme/payments/pull/482',
    });
    sqlite
      .prepare(
        `INSERT INTO task_pull_request_associations
           (task_id, project_id, pr_url, disposition, reason, recorded_by_user_id, created_at)
         VALUES ('work-1', 'p1', 'https://github.com/acme/payments/pull/500', 'owned', 'test',
                 'u1', '2026-10-22T00:00:00.000Z')`
      )
      .run();
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [{ sessionId: 'sess-a', sessionTaskId: 'work-1' }])
    );

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.counts.pullRequests).toBe(2);
    // Neither pull request has stored state, so the idea cannot claim review or merged — the
    // control for the two tests above, which prove it does once the state exists.
    expect(body.items[0]?.derived.state).toBe('not-started');
  });

  it('reaches review from an open pull request the platform has stored', async () => {
    seedIdea('idea-1');
    seedWorkTask('work-1', {
      status: 'completed',
      outputPrUrl: 'https://github.com/acme/payments/pull/482',
    });
    seedPullRequestState('p1', 'acme/payments', 482, { checksState: 'failure' });
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [{ sessionId: 'sess-a', sessionTaskId: 'work-1' }])
    );

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.derived.state).toBe('review');
    expect(body.items[0]?.derived.pullRequest).toMatchObject({
      number: 482,
      state: 'open',
      checksState: 'failure',
      source: 'task_output',
    });
  });

  it('reaches merged, and needs a person, once that pull request is merged', async () => {
    seedIdea('idea-1');
    seedWorkTask('work-1', {
      status: 'completed',
      outputPrUrl: 'https://github.com/acme/payments/pull/482',
    });
    seedPullRequestState('p1', 'acme/payments', 482, {
      state: 'merged',
      mergedAt: '2026-10-22T09:00:00.000Z',
    });
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [{ sessionId: 'sess-a', sessionTaskId: 'work-1' }])
    );

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.derived.state).toBe('merged');
    expect(body.items[0]?.derived.needsYou).toBe('merged');
  });

  // Program decision 3: one pull request reached through three sources is one item.
  it('collapses the same pull request reached from task output, an association and a link', async () => {
    seedIdea('idea-1');
    seedWorkTask('work-1', {
      status: 'completed',
      outputPrUrl: 'https://github.com/acme/payments/pull/482',
    });
    sqlite
      .prepare(
        `INSERT INTO task_pull_request_associations
           (task_id, project_id, pr_url, disposition, reason, recorded_by_user_id, created_at)
         VALUES ('work-1', 'p1', 'https://GITHUB.com/Acme/Payments/pull/482/', 'owned', 'test',
                 'u1', '2026-10-22T00:00:00.000Z')`
      )
      .run();
    seedPullRequestState('p1', 'acme/payments', 482);
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [{ sessionId: 'sess-a', sessionTaskId: 'work-1' }], {
        pullRequestUrls: ['https://github.com/acme/payments/pull/482'],
      })
    );

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.counts.pullRequests).toBe(1);
    expect(body.items[0]?.derived.state).toBe('review');
  });

  // A link to a pull request in another repository is not this project's work, and must not
  // be counted or able to move the idea.
  it('drops a pull request that does not belong to the project’s repository', async () => {
    seedIdea('idea-1');
    seedWorkTask('work-1', { status: 'completed' });
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [{ sessionId: 'sess-a', sessionTaskId: 'work-1' }], {
        pullRequestUrls: ['https://github.com/someone/else/pull/1'],
      })
    );

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.counts.pullRequests).toBe(0);
    expect(body.items[0]?.derived.state).toBe('not-started');
  });

  // The strength rule, through the route: a chat that only read the idea contributes nothing,
  // and the chat that works on it still does.
  it('ignores a weakly linked chat’s task and pull request', async () => {
    seedIdea('idea-1');
    seedWorkTask('reader-task', {
      status: 'in_progress',
      outputPrUrl: 'https://github.com/acme/payments/pull/900',
    });
    seedPullRequestState('p1', 'acme/payments', 900);
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [
        {
          sessionId: 'sess-reader',
          sessionTaskId: 'reader-task',
          relations: ['read'],
          strong: false,
        },
      ])
    );

    const body = (await (await list()).json()) as IdeasListBody;
    // The chat is still listed — an empty response would satisfy the absence on its own.
    expect(body.items[0]?.counts.chats).toBe(1);
    expect(body.items[0]?.counts.pullRequests).toBe(0);
    expect(body.items[0]?.derived.state).toBe('not-started');
  });

  it('counts the notes and files the link store reports, and says when a count is a minimum', async () => {
    seedIdea('idea-1');
    mocks.getIdeaWorkSnapshots.mockResolvedValue(
      snapshot('idea-1', [{ sessionId: 'sess-a' }], {
        fileIds: ['file-1', 'file-2'],
        updates: 4,
        truncated: { files: true },
      })
    );

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.counts).toMatchObject({ updates: 4, files: 2, chats: 1 });
    expect(body.items[0]?.counts.atLeast).toEqual(['files']);
  });

  it('folds an automation-filed idea into its own group and names what filed it', async () => {
    seedIdea('incident-1', { triggeredBy: 'incident' });
    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]).toMatchObject({ filedByAgent: true, filedBy: 'incident' });
  });

  it('does not treat a connector-created idea as agent-filed, but says which client', async () => {
    seedIdea('via-connector', { triggeredBy: 'connector', connectorClientName: 'Claude' });
    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]).toMatchObject({
      filedByAgent: false,
      filedBy: null,
      viaConnector: 'Claude',
    });
  });

  it('says only "Connector" when the client did not name itself', async () => {
    seedIdea('via-connector', { triggeredBy: 'connector', connectorClientName: null });
    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.viaConnector).toBe('Connector');
  });

  it('leaves viaConnector empty for an idea a person typed here', async () => {
    seedIdea('typed-here');
    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]?.viaConnector).toBeNull();
  });

  it('returns finished and parked ideas alongside the open ones, with totals', async () => {
    seedIdea('open-1');
    seedIdea('done-1', { status: 'completed' });
    seedIdea('parked-1', { status: 'cancelled' });

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items.map((item) => item.derived.state).sort()).toEqual([
      'done',
      'not-started',
      'parked',
    ]);
    expect(body.totals).toEqual({ open: 1, done: 1, parked: 1 });
  });

  it('ranks open ideas ahead of finished ones rather than by recency', async () => {
    // A project that shipped a lot: every finished idea is newer than the open one. Ranking
    // by `updated_at` alone would spend the page on them (rule 65).
    for (let index = 0; index < 5; index += 1) {
      seedIdea(`done-${index}`, {
        status: 'completed',
        updatedAt: `2026-10-2${index}T00:00:00.000Z`,
      });
    }
    seedIdea('open-1', { updatedAt: '2026-10-01T00:00:00.000Z' });

    const res = await app.request(
      `${BASE}/p1/ideas?openLimit=1&closedLimit=1`,
      { method: 'GET' },
      env
    );
    const body = (await res.json()) as IdeasListBody;
    expect(body.items.map((item) => item.ideaId)).toContain('open-1');
    expect(body.truncated).toBe(true);
    expect(body.totals).toEqual({ open: 1, done: 5, parked: 0 });
  });

  // A full page, not a comfortable number: the open cap is 100, so this is the most a single
  // request can ask for. The cost must still be a fixed handful of round trips rather than
  // anything per idea (rule 60). The property asserted is the one that matters — the count
  // does not move with the idea count — because a fixed expected number silently passes when
  // a per-idea read is added alongside a removed one.
  it('reads a full page of ideas at the same cost as one', async () => {
    seedIdea('only');
    // One warm-up read first: the link caps come from the admin settings registry, which
    // caches per isolate, so a cold request costs two extra reads a deployed Worker pays
    // once rather than per page.
    await list();
    queries.length = 0;
    expect((await list()).status).toBe(200);
    const oneIdea = queries.length;

    // 99 more, so the page is exactly the 100-idea open cap and nothing is truncated.
    for (let index = 0; index < 99; index += 1) seedIdea(`idea-${index}`);
    queries.length = 0;
    mocks.snapshotCalls = [];

    const res = await list();
    expect(res.status).toBe(200);
    expect(((await res.json()) as IdeasListBody).items).toHaveLength(100);
    expect(queries).toHaveLength(oneIdea);
    // Read-only GET budget (rule 60). Warm, the reads are: the open ideas, the finished
    // ones, the totals and the project repository; cold adds the two admin-settings reads
    // behind the link caps, and a page with pull requests adds T2's two.
    expect(queries.length).toBeLessThanOrEqual(8);
    // The Durable Object is asked once, for every idea at the same time.
    expect(mocks.snapshotCalls).toHaveLength(1);
    expect(mocks.snapshotCalls[0]).toHaveLength(100);
    // And the list never asks anyone to go and refresh a pull request: a page of 100 ideas
    // would be 100 GitHub calls. Only the single-idea read may ask for that.
    expect(IDEA_PULL_REQUEST_REFRESH.list).toBe('none');
    expect(IDEA_PULL_REQUEST_REFRESH.detail).toBe('single');
  });

  /**
   * The same property, with the linkage a real project has.
   *
   * The page above seeds 100 ideas with NO linked chats, so `readSessionTasks`,
   * `readAssociatedPullRequests` and `readAgentProfileNames` never fire in it — they are
   * guarded on `sessionTaskIds.length > 0`. A busy project's ideas mostly do have a chat, and
   * those three reads chunk at 96 task ids, so they are where the count could start growing.
   * This seeds more distinct linked tasks than one chunk holds, which is the case a
   * "realistic" fixture would have missed by landing under the boundary.
   */
  it('stays batched when every idea on the page has linked work', async () => {
    const ideaCount = 100;
    // 2 chats each: 200 distinct task ids, so the 96-per-query chunking runs three times.
    const snapshots: Record<string, unknown> = {};
    for (let index = 0; index < ideaCount; index += 1) {
      const ideaId = `idea-${index}`;
      seedIdea(ideaId);
      for (const slot of [0, 1]) {
        seedWorkTask(`work-${index}-${slot}`, {
          status: 'in_progress',
          agentProfileHint: 'prof-opus',
        });
      }
      snapshots[ideaId] = {
        ideaId,
        sessions: [0, 1].map((slot) => ({
          sessionId: `sess-${index}-${slot}`,
          topic: 'A chat',
          sessionStatus: 'active',
          sessionTaskId: `work-${index}-${slot}`,
          lastActivityAt: minutesAgo(5),
          relations: ['works_on'] as LinkRelation[],
          strong: true,
          linkedAt: minutesAgo(60),
        })),
        needsInput: [],
        fileIds: [],
        pullRequestUrls: [],
        updates: 0,
        truncated: { sessions: false, files: false, pullRequests: false },
      };
    }
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, created_at, updated_at)
         VALUES ('prof-opus', 'p1', 'u1', 'Opus 5.5', 'claude-code', '2026-10-01', '2026-10-01')`
      )
      .run();
    // Keep the call recorder from `beforeEach`: `mockResolvedValue` would replace it, and the
    // assertion below is that this is called exactly ONCE for the whole page.
    mocks.getIdeaWorkSnapshots.mockImplementation(
      async (_env: unknown, _projectId: string, ideaIds: readonly string[]) => {
        mocks.snapshotCalls.push([...ideaIds]);
        return snapshots;
      }
    );

    await list(); // warm the admin-settings cache, as above
    queries.length = 0;
    mocks.snapshotCalls = [];

    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as IdeasListBody;
    expect(body.items).toHaveLength(ideaCount);
    // The linkage really is there, so a page that silently dropped it cannot pass this.
    expect(body.items[0]?.counts.chats).toBe(2);
    expect(body.items[0]?.derived.state).toBe('working');

    // Still one Durable Object call for the whole page.
    expect(mocks.snapshotCalls).toHaveLength(1);
    // The three linkage reads chunk at 96 ids: 200 distinct task ids is 3 chunks each for
    // `readSessionTasks` and `readAssociatedPullRequests`, plus 1 for the single profile id.
    // Still a fixed handful, and still nothing per idea — 100 ideas would otherwise be 100+.
    expect(queries.length).toBeLessThanOrEqual(20);
    expect(queries.length).toBeLessThan(ideaCount);
  });

  it('does not list a task that is not an idea', async () => {
    seedWorkTask('plain', { status: 'completed' });
    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items).toHaveLength(0);
  });

  // Every ordinary task is created in `draft` (`routes/tasks/crud.ts`), so a predicate that
  // accepted `status = 'draft'` would publish other people's undispatched work as ideas — and,
  // through the status route below, let anyone complete it. The flag is the whole definition;
  // the migration backfills the rows that predate it.
  it('does not list an undispatched ordinary task as an idea', async () => {
    seedWorkTask('fresh', { status: 'draft' });
    seedIdea('real');
    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items.map((item) => item.ideaId)).toEqual(['real']);
  });

  it('will not read an undispatched ordinary task through the idea route', async () => {
    seedWorkTask('fresh', { status: 'draft' });
    const res = await app.request(`${BASE}/p1/ideas/fresh`, { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });

  // The control for the two above: the owner's own idea still reads, so "404" cannot pass by
  // the route being broken outright.
  it('reads the project’s own idea', async () => {
    seedIdea('real');
    const res = await app.request(`${BASE}/p1/ideas/real`, { method: 'GET' }, env);
    expect(res.status).toBe(200);
  });

  it('lists a finished idea, which only the flag can identify', async () => {
    seedIdea('shipped', { status: 'completed' });
    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items[0]).toMatchObject({ ideaId: 'shipped' });
    expect(body.items[0]?.derived.state).toBe('done');
  });

  // Attack case: another project's real idea id through a project the caller can reach.
  it('will not show one project’s idea through another', async () => {
    seedIdea('victim', { projectId: 'p2' });
    const res = await app.request(`${BASE}/p1/ideas/victim`, { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });

  // Owner control.
  it('does show that idea through its own project', async () => {
    seedIdea('victim', { projectId: 'p2' });
    const res = await app.request(`${BASE}/p2/ideas/victim`, { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ideaId: string }).ideaId).toBe('victim');
  });

  it('will not change one project’s idea through another, and changes nothing', async () => {
    seedIdea('victim', { projectId: 'p2' });
    const res = await app.request(
      `${BASE}/p1/ideas/victim/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      },
      env
    );
    expect(res.status).toBe(404);
    expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('victim')).toEqual({
      status: 'draft',
    });
  });

  // The status route runs the *idea* transition table, which allows `draft -> completed` with
  // no dependency check and no terminal-resource cleanup. An ordinary task must never reach it:
  // that would be a way to mark unrun work done.
  it('will not complete an undispatched ordinary task through the idea route', async () => {
    seedWorkTask('fresh', { status: 'draft' });
    const res = await app.request(
      `${BASE}/p1/ideas/fresh/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      },
      env
    );
    expect(res.status).toBe(404);
    expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('fresh')).toEqual({
      status: 'draft',
    });
  });

  it('marks an idea done through the route and returns its new state', async () => {
    seedIdea('idea-1');
    const res = await app.request(
      `${BASE}/p1/ideas/idea-1/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; derived: { state: string } };
    expect(body.status).toBe('completed');
    expect(body.derived.state).toBe('done');
  });

  // The mocked middleware cannot reject anything, so these assert the capability each route
  // ASKS for. Without them a mutating route could be downgraded to `task:read` and every test
  // here would stay green.
  it('asks for write capability before changing an idea, and read before showing one', async () => {
    seedIdea('idea-1');
    await app.request(
      `${BASE}/p1/ideas/idea-1/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      },
      env
    );
    await app.request(`${BASE}/p1/ideas/idea-1/keep-open`, { method: 'POST' }, env);
    await app.request(
      `${BASE}/p1/ideas`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'new' }),
      },
      env
    );
    expect(mocks.requireProjectCapability.mock.calls.map((call) => call[3])).toEqual([
      'task:write',
      'task:write',
      'task:write',
    ]);

    mocks.requireProjectCapability.mockClear();
    await app.request(`${BASE}/p1/ideas`, { method: 'GET' }, env);
    await app.request(`${BASE}/p1/ideas/idea-1`, { method: 'GET' }, env);
    // Reads go through project access, never the write capability.
    expect(mocks.requireProjectCapability).not.toHaveBeenCalled();
    expect(mocks.requireProjectAccess).toHaveBeenCalled();
  });

  it('parks an idea through the route', async () => {
    seedIdea('idea-1');
    const res = await app.request(
      `${BASE}/p1/ideas/idea-1/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; derived: { state: string } };
    expect(body.status).toBe('cancelled');
    expect(body.derived.state).toBe('parked');
  });

  it('refuses a status that is not a person’s decision', async () => {
    seedIdea('idea-1');
    const res = await app.request(
      `${BASE}/p1/ideas/idea-1/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it('records "Keep open" without moving the idea', async () => {
    seedIdea('idea-1');
    const res = await app.request(`${BASE}/p1/ideas/idea-1/keep-open`, { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const row = sqlite
      .prepare('SELECT status, idea_merge_ack_at FROM tasks WHERE id = ?')
      .get('idea-1') as { status: string; idea_merge_ack_at: string | null };
    expect(row.status).toBe('draft');
    expect(row.idea_merge_ack_at).toBeTruthy();
  });

  it('files a new idea a person typed, and it comes back as an idea', async () => {
    const res = await app.request(
      `${BASE}/p1/ideas`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Retry webhooks', content: 'With backoff.' }),
      },
      env
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { ideaId: string; derived: { state: string } };
    expect(created.derived.state).toBe('not-started');
    const row = sqlite
      .prepare('SELECT is_idea, status, title FROM tasks WHERE id = ?')
      .get(created.ideaId) as { is_idea: number; status: string; title: string };
    expect(row).toEqual({ is_idea: 1, status: 'draft', title: 'Retry webhooks' });

    const body = (await (await list()).json()) as IdeasListBody;
    expect(body.items.map((item) => item.ideaId)).toEqual([created.ideaId]);
  });

  it('refuses a new idea with no title', async () => {
    const res = await app.request(
      `${BASE}/p1/ideas`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '   ' }),
      },
      env
    );
    expect(res.status).toBe(400);
  });
});
