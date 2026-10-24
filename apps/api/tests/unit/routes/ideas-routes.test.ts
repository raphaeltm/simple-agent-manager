/**
 * The Ideas list and idea page through the real Hono routes, a real SQLite engine and a
 * ProjectData stub that answers the batched link read the way the Durable Object does.
 *
 * This is the vertical slice the derivation tests cannot give: it proves the route reaches
 * `deriveIdeaStatus` with evidence collected from both stores, that the page's reads stay
 * batched as the idea count grows, and that one project cannot read or change another's
 * ideas. Each attack case has an owner control beside it.
 */
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
      note: string | null;
    };
    counts: { chats: number; pullRequests: number; files: number; updates: number };
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

  function snapshot(
    ideaId: string,
    sessions: Partial<SnapshotSession>[],
    needsInput: Array<{ sessionId: string; question: string | null; askedAt: number }> = []
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
          linkedAt: session.linkedAt ?? minutesAgo(60),
        })),
        needsInput,
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
      snapshot(
        'idea-1',
        [{ sessionId: 'sess-a', sessionTaskId: 'work-1' }],
        [{ sessionId: 'sess-a', question: 'Cap retries at 3 days?', askedAt: minutesAgo(2) }]
      )
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
    // No stored state is wired yet (T2 owns it), so the idea cannot claim review or merged.
    expect(body.items[0]?.derived.state).toBe('not-started');
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
  // anything per idea (rule 60).
  it('reads a full page of ideas without a query per idea', async () => {
    for (let index = 0; index < 100; index += 1) seedIdea(`idea-${index}`);
    queries.length = 0;

    const res = await list();
    expect(res.status).toBe(200);
    expect(((await res.json()) as IdeasListBody).items).toHaveLength(100);
    // Three idea reads (open, closed, totals) and nothing per idea. The Durable Object is
    // asked once, for every idea at the same time.
    expect(queries).toHaveLength(3);
    expect(mocks.snapshotCalls).toHaveLength(1);
    expect(mocks.snapshotCalls[0]).toHaveLength(100);
    // And the list never asks anyone to go and refresh a pull request: a page of 100 ideas
    // would be 100 GitHub calls. Only the single-idea read may ask for that.
    expect(IDEA_PULL_REQUEST_REFRESH.list).toBe('none');
    expect(IDEA_PULL_REQUEST_REFRESH.detail).toBe('single');
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
