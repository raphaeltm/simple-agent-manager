/**
 * `GET /api/projects/:projectId/insights/accounts` and `/people` through the real
 * `projectInsightsRoutes` mount and the production error handler, on a real SQL engine. Session
 * auth is replaced by a fixed viewer (the routes rely on `requireAuth` + `requireApproved` and
 * each operation's membership check). Proves the mounts, the range parsing, the private no-store
 * header, the outsider refusal, and that another member's private data never reaches the body:
 * an account name (Accounts) or an inbox item title (People).
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

import type { ProjectAccountsResponse, ProjectPeopleResponse } from '@simple-agent-manager/shared';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { projectInsightsRoutes } from '../../../src/routes/project-insights';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('GET /api/projects/:projectId/insights/accounts', () => {
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
      INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv) VALUES
        ('cc-own', 'owner', 'Personal Max', 'oauth-token', 'ct', 'iv'),
        ('cc-mate', 'mate', 'Mate Secret Name', 'oauth-token', 'ct', 'iv');
      INSERT INTO workspaces (id, project_id, user_id, name, repository, branch, status, vm_size, vm_location) VALUES
        ('w1', 'p', 'owner', 'w1', 'acme/app', 'main', 'deleted', 'small', 'fsn1'),
        ('w2', 'p', 'mate', 'w2', 'acme/app', 'main', 'deleted', 'small', 'fsn1');
      INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, agent_credential_source, agent_credential_reference) VALUES
        ('s1', 'w1', 'owner', 'stopped', 'claude-code', 'user', 'cc_credentials:cc-own'),
        ('s2', 'w2', 'mate', 'stopped', 'claude-code', 'user', 'cc_credentials:cc-mate');
      INSERT INTO tasks (id, project_id, user_id, title, status, task_mode, is_idea, workspace_id, created_at, updated_at, completed_at) VALUES
        ('t1', 'p', 'owner', 'Run 1', 'completed', 'task', 0, 'w1', '${recent}', '${recent}', '${recent}'),
        ('t2', 'p', 'mate', 'Run 2', 'completed', 'task', 0, 'w2', '${recent}', '${recent}', '${recent}');
    `);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  const get = (query = '') => app.request(`/api/projects/p/insights/accounts${query}`, {}, env);

  it('returns the viewer’s accounts, private and uncached', async () => {
    const response = await get('?range=7d');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await response.json()) as ProjectAccountsResponse;
    expect(body.range).toBe('7d');
    expect(body.accounts.map((a) => [a.key, a.name, a.runs])).toEqual([
      ['cred:cc-own', 'Personal Max', 1],
      ['teammate:claude-code:subscription', null, 1],
    ]);
    expect(JSON.stringify(body)).not.toContain('Mate Secret Name');
  });

  it('rejects an unknown range with 400', async () => {
    expect((await get('?range=365d')).status).toBe(400);
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

describe('GET /api/projects/:projectId/insights/people', () => {
  let sqlite: Database.Database;
  let env: Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/projects/:projectId/insights', projectInsightsRoutes);

  beforeEach(() => {
    viewer.id = 'owner';
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const day = Date.now() - 86_400_000;
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app');
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'),
        ('mate','Mate','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','mate','member','active');
      INSERT INTO asks (id, project_id, assignee_kind, assignee_user_id, kind, title, status, created_at, updated_at) VALUES
        ('a1', 'p', 'user', 'owner', 'question', 'Owner question', 'open', ${day}, ${day}),
        ('a2', 'p', 'user', 'mate', 'question', 'Mate Secret Question', 'open', ${day}, ${day});
    `);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  const get = (query = '') => app.request(`/api/projects/p/insights/people${query}`, {}, env);

  it('returns who work waits on, private and uncached', async () => {
    const response = await get('?range=7d');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await response.json()) as ProjectPeopleResponse;
    expect(body.range).toBe('7d');
    expect(body.waiting.total).toBe(2);
    expect(body.waiting.groups.map((g) => [g.key, g.items[0]?.title ?? null])).toEqual([
      ['mate', null],
      ['owner', 'Owner question'],
    ]);
    expect(JSON.stringify(body)).not.toContain('Mate Secret Question');
    expect(body.reviewPickup.state).toBe('not_recorded');
  });

  it('rejects an unknown range with 400', async () => {
    expect((await get('?range=365d')).status).toBe(400);
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
