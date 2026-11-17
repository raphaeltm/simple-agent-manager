/**
 * `GET /api/projects/:projectId/insights/setups` through the real `projectInsightsRoutes` mount and
 * the production error handler, on a real SQL engine. Session auth is replaced by a fixed viewer.
 * Proves the mount, range and grouping parsing, the private no-store header, the outsider refusal,
 * and that a teammate's personal profile name never reaches the body. There is no ProjectData
 * binding here, so the nudge read fails and the page reports only that section unavailable.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const viewer = vi.hoisted(() => ({ id: 'owner' }));
vi.mock('../../../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
    requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
    getUserId: () => viewer.id,
  };
});

import type { ProjectSetupsResponse } from '@simple-agent-manager/shared';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { projectInsightsRoutes } from '../../../src/routes/project-insights';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('GET /api/projects/:projectId/insights/setups', () => {
  let sqlite: Database.Database;
  let env: Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/projects/:projectId/insights', projectInsightsRoutes);

  beforeEach(() => {
    viewer.id = 'owner';
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app');
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'),
        ('mate','Mate','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','mate','member','active');
      INSERT INTO agent_profiles (id, project_id, user_id, name) VALUES
        ('prof-p', 'p', 'owner', 'Project Opus'), ('prof-mate', NULL, 'mate', 'Mate Secret Profile');
      INSERT INTO workspaces (id, project_id, user_id, name, repository, branch, status, vm_size, vm_location) VALUES
        ('w1', 'p', 'owner', 'w1', 'acme/app', 'main', 'deleted', 'small', 'fsn1'),
        ('w2', 'p', 'mate', 'w2', 'acme/app', 'main', 'deleted', 'small', 'fsn1');
      INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, agent_profile_id) VALUES
        ('s1', 'w1', 'owner', 'stopped', 'claude-code', 'prof-p'),
        ('s2', 'w2', 'mate', 'stopped', 'claude-code', 'prof-mate');
      INSERT INTO tasks (id, project_id, user_id, title, status, task_mode, is_idea, workspace_id, chat_session_id, created_at, updated_at, completed_at) VALUES
        ('t1', 'p', 'owner', 'Run 1', 'completed', 'task', 0, 'w1', 'c1', '${recent}', '${recent}', '${recent}'),
        ('t2', 'p', 'mate', 'Run 2', 'completed', 'task', 0, 'w2', 'c2', '${recent}', '${recent}', '${recent}');
    `);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  const get = (query = '') => app.request(`/api/projects/p/insights/setups${query}`, {}, env);

  it('returns the setups, private and uncached, naming only what the viewer may see', async () => {
    const response = await get('?range=7d&groupBy=profile');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await response.json()) as ProjectSetupsResponse;
    expect(body).toMatchObject({ range: '7d', groupBy: 'profile' });
    expect(body.groups.map((g) => [g.key, g.label, g.owner, g.runs])).toEqual([
      ['prof-mate', null, 'teammate', 1],
      ['prof-p', 'Project Opus', 'project', 1],
    ]);
    expect(JSON.stringify(body)).not.toContain('Mate Secret Profile');
    expect(body.unavailable).toEqual(['nudges']);
  });

  it('defaults the grouping and rejects an unknown range or grouping with 400', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProjectSetupsResponse).groupBy).toBe('profile');
    expect((await get('?range=365d')).status).toBe(400);
    expect((await get('?groupBy=person')).status).toBe(400);
  });

  it('refuses a caller who is not a member of the project', async () => {
    viewer.id = 'outsider';
    const response = await get();
    expect([403, 404]).toContain(response.status);
    // Owner control.
    viewer.id = 'owner';
    expect((await get()).status).toBe(200);
  });
});
