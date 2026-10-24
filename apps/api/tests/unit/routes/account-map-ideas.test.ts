import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { accountMapRoutes } from '../../../src/routes/account-map';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'owner',
}));
vi.mock('../../../src/services/agent-activity', () => ({
  listAgentActivityTasks: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/services/project-data', () => ({ listSessions: vi.fn() }));
vi.mock('../../../src/operations/link-core', () => ({ listLinksForTargets: vi.fn() }));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSettingDetailsMany: vi
    .fn()
    .mockResolvedValue([{ value: 10 }, { value: 100 }, { value: 100 }, { value: 50 }]),
}));

import { listLinksForTargets } from '../../../src/operations/link-core';
import { listAgentActivityTasks } from '../../../src/services/agent-activity';
import { listSessions } from '../../../src/services/project-data';

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.projects, schema.nodes, schema.workspaces, schema.tasks]);
  env = {
    DATABASE: createSqliteD1(sqlite),
    KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env;
  vi.mocked(listSessions).mockImplementation(
    async (_env, projectId) =>
      ({
        sessions: [
          {
            id: `chat-${projectId}`,
            topic: 'Linked chat',
            status: 'active',
            messageCount: 2,
            workspaceId: null,
            taskId: null,
          },
        ],
        total: 1,
        nextCursor: null,
      }) as never
  );
  vi.mocked(listLinksForTargets).mockImplementation(async (_env, projectId) => {
    const ideaId = projectId === 'mine-a' ? 'idea-own-a' : 'idea-own-b';
    return [
      {
        sourceKind: 'session',
        sourceId: `chat-${projectId}`,
        targetKind: 'idea',
        targetId: ideaId,
        relation: 'works_on',
        lastAt: 10,
      },
      // A forged cross-project link must not make a foreign idea visible.
      {
        sourceKind: 'session',
        sourceId: `chat-${projectId}`,
        targetKind: 'idea',
        targetId: 'idea-foreign',
        relation: 'linked',
        lastAt: 11,
      },
      {
        sourceKind: 'session',
        sourceId: `chat-${projectId}`,
        targetKind: 'idea',
        targetId: 'idea-own-b',
        relation: 'linked',
        lastAt: 12,
      },
      /*
       * The attack row must be LINKED, or it proves nothing.
       *
       * `account-map.ts:301` filters candidates down to ideas that have links
       * (`candidateIdeas.filter((idea) => linkedIdeaIds.has(idea.id))`), so an unlinked row is
       * dropped whatever the predicate says. Verified: with this link absent, restoring the old
       * `status = 'draft'` predicate left the test GREEN — an attack case that could not fail.
       * With the link present, the only thing keeping `ordinary-draft` out of the owner's own
       * Account Map is `is_idea = 0`.
       */
      {
        sourceKind: 'session',
        sourceId: `chat-${projectId}`,
        targetKind: 'idea',
        targetId: 'ordinary-draft',
        relation: 'works_on',
        lastAt: 13,
      },
    ] as never;
  });
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

function seedProject(id: string, userId: string, activity: number) {
  sqlite
    .prepare('INSERT INTO projects (id,user_id,name,last_activity_at) VALUES (?,?,?,?)')
    .run(id, userId, id, activity);
}
function seedIdea(id: string, projectId: string, updatedAt: string) {
  // `is_idea = 1` is what makes a row an idea now, not `status = 'draft'` (program decision
  // 16, migration 0207). The column is NOT NULL DEFAULT 0, so an idea fixture has to say so.
  sqlite
    .prepare(
      'INSERT INTO tasks (id,project_id,title,status,is_idea,updated_at) VALUES (?,?,?,?,1,?)'
    )
    .run(id, projectId, id, 'draft', updatedAt);
}

async function requestMap() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/account-map', accountMapRoutes);
  return app.request('/api/account-map', {}, env);
}

describe('Account Map linked ideas', () => {
  it('uses real owner-scoped SQL across projects, excludes a forged foreign idea, and marks works_on primary', async () => {
    seedProject('mine-a', 'owner', 20);
    seedProject('mine-b', 'owner', 10);
    seedProject('theirs', 'attacker', 30);
    seedIdea('idea-own-a', 'mine-a', '2026-10-24T04:00:00Z');
    seedIdea('idea-own-b', 'mine-b', '2026-10-24T03:00:00Z');
    seedIdea('idea-foreign', 'theirs', '2026-10-24T05:00:00Z');
    sqlite
      .prepare(
        "INSERT INTO tasks (id,project_id,title,status,is_idea,updated_at) VALUES ('ordinary','mine-a','Ordinary task','ready',0,'2026-10-24T06:00:00Z')"
      )
      .run();
    // The discriminating row: draft, owner's own project, excluded only by the flag. The
    // `ready` row above is excluded by its status too, so it passes under either definition
    // and cannot tell them apart.
    sqlite
      .prepare(
        "INSERT INTO tasks (id,project_id,title,status,is_idea,updated_at) VALUES ('ordinary-draft','mine-a','Ordinary draft task','draft',0,'2026-10-24T07:00:00Z')"
      )
      .run();

    const response = await requestMap();
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ideas.map((idea: { id: string }) => idea.id)).toEqual(['idea-own-a', 'idea-own-b']);
    /*
     * The attack case and its owner control, named rather than left to the array equality
     * above — an edit that loosened that assertion would otherwise drop this silently.
     *
     * `ordinary-draft` is `status = 'draft'` in the owner's OWN project, so the only thing
     * keeping it out of someone's Account Map is `is_idea = 0`. Under the previous
     * "an idea is a task in draft" rule it would have been listed as one. `ordinary` is
     * `ready` and `idea-foreign` belongs to another user, so neither can discriminate here.
     */
    expect(
      body.ideas.some(
        (idea: { id: string }) =>
          idea.id === 'idea-foreign' || idea.id === 'ordinary' || idea.id === 'ordinary-draft'
      )
    ).toBe(false);
    // The owner control: the same query, same project, still returns the real ideas — so the
    // refusal above cannot be the query being broken for everything.
    expect(body.ideas.map((idea: { id: string }) => idea.id)).toContain('idea-own-a');
    expect(body.relationships).toContainEqual(
      expect.objectContaining({
        source: 'idea-own-a',
        target: 'chat-mine-a',
        type: 'idea_session',
        primary: true,
      })
    );
    expect(body.relationships).toContainEqual(
      expect.objectContaining({ source: 'mine-a', target: 'idea-own-a', type: 'has_idea' })
    );
    expect(
      body.relationships.some(
        (edge: { source: string; target: string }) =>
          edge.source === 'idea-foreign' || edge.target === 'idea-foreign'
      )
    ).toBe(false);
    expect(body.relationships).not.toContainEqual(
      expect.objectContaining({ source: 'idea-own-b', target: 'chat-mine-a' })
    );
    expect(listLinksForTargets).toHaveBeenCalledTimes(2);
  });

  it('bounds more than 100 idea candidates with json_each IDs and discloses truncation', async () => {
    seedProject('mine-a', 'owner', 20);
    for (let index = 0; index < 125; index++) {
      seedIdea(
        `idea-${index}`,
        'mine-a',
        `2026-10-24T04:${String(index % 60).padStart(2, '0')}:00Z`
      );
    }
    vi.mocked(listLinksForTargets).mockResolvedValueOnce([
      {
        sourceKind: 'session',
        sourceId: 'chat-mine-a',
        targetKind: 'idea',
        targetId: 'idea-59',
        relation: 'works_on',
        lastAt: 10,
      },
    ] as never);
    const response = await requestMap();
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.truncation.ideas).toBe(true);
    expect(body.ideaScan).toEqual({ projectLimit: 10, candidateLimit: 100 });
    expect(body.ideas).toContainEqual(expect.objectContaining({ id: 'idea-59' }));
    expect(body.relationships).toContainEqual(
      expect.objectContaining({ source: 'idea-59', target: 'chat-mine-a', type: 'idea_session' })
    );
    expect(listLinksForTargets).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listLinksForTargets).mock.calls[0]?.[3]).toHaveLength(100);
  });

  it('discloses when idea links are checked for recent projects only', async () => {
    for (let index = 0; index < 11; index++) seedProject(`owned-${index}`, 'owner', index);
    const response = await requestMap();
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.projects).toHaveLength(11);
    expect(body.truncation.projects).toBe(false);
    expect(body.truncation.linkProjects).toBe(true);
    expect(body.ideaScan.projectLimit).toBe(10);
  });

  it('keeps older project resources while bounding only its idea-link reads', async () => {
    for (let index = 0; index < 11; index++) seedProject(`owned-${index}`, 'owner', index);
    sqlite
      .prepare(
        'INSERT INTO workspaces (id,user_id,project_id,status,display_name) VALUES (?,?,?,?,?)'
      )
      .run('old-workspace', 'owner', 'owned-0', 'running', 'Old');
    vi.mocked(listAgentActivityTasks).mockResolvedValueOnce([
      {
        id: 'old-task',
        projectId: 'owned-0',
        title: 'Older project task',
        status: 'in_progress',
        workspaceId: 'old-workspace',
        agentActivityState: 'working',
      },
    ] as never);

    const response = await requestMap();
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.workspaces.map((workspace: { id: string }) => workspace.id)).toContain(
      'old-workspace'
    );
    expect(body.tasks.map((task: { id: string }) => task.id)).toContain('old-task');
    expect(vi.mocked(listAgentActivityTasks).mock.calls).toHaveLength(1);
  });
});
