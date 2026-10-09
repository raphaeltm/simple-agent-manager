import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { cliProjectMetadataRoutes } from '../../../src/routes/cli-project-metadata';

const auth = vi.hoisted(() => ({ capability: vi.fn(), builtin: false }));
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'user',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: auth.capability,
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/services/agent-profiles', () => ({
  createProfile: vi.fn(),
  getProfile: async () => ({ id: 'profile', projectId: 'project', updatedAt: 'old' }),
}));
vi.mock('../../../src/services/skills', () => ({
  createSkill: vi.fn(),
  getSkill: async () => ({
    id: 'skill',
    projectId: 'project',
    updatedAt: 'old',
    isBuiltin: auth.builtin,
  }),
}));
let db: Database.Database;
let app: Hono<{ Bindings: Env }>;
let env: Env;
beforeEach(() => {
  auth.builtin = false;
  auth.capability.mockReset().mockResolvedValue({});
  db = new Database(':memory:');
  db.exec(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, normalized_name TEXT, description TEXT, updated_at TEXT); CREATE UNIQUE INDEX project_names ON projects(user_id, normalized_name); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE agent_profiles(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, description TEXT, updated_at TEXT); CREATE TABLE skills(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, description TEXT, updated_at TEXT); INSERT INTO projects VALUES('project','user','original','original',NULL,'old'); INSERT INTO users VALUES('user'); INSERT INTO agent_profiles VALUES('profile','project','Sol',NULL,'old');"
  );
  db.exec(
    readFileSync(
      join(process.cwd(), 'src', 'db', 'migrations', '0189_cli_operation_receipts.sql'),
      'utf8'
    )
  );
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }),
        first: async () => db.prepare(sql).get(...values) ?? null,
      }),
    }),
  };
  env = { DATABASE: database } as unknown as Env;
  app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as 400)
      : c.json({ error: 'fixture_error' }, 500)
  );
  app.route('/api/projects/:projectId/cli', cliProjectMetadataRoutes);
});
afterEach(() => db.close());
function patch(path: string, body: unknown) {
  return app.request(
    `http://fixture/api/projects/project/cli/${path}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}
describe('server scoped CLI metadata boundary', () => {
  it.each([
    'permissionMode',
    'githubCliPolicy',
    'credential',
    'runtime',
    'billing',
    'model',
    'defaultProfileId',
  ])('rejects a mixed settings patch with %s before mutation', async (field) => {
    const res = await patch('settings', {
      name: 'changed',
      expectedUpdatedAt: 'old',
      [field]: { secret: 'canary' },
    });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT name FROM projects').get()).toEqual({ name: 'original' });
  });
  it('compare-and-set rejects stale edits and preserves metadata', async () => {
    expect((await patch('settings', { name: 'first', expectedUpdatedAt: 'old' })).status).toBe(200);
    expect((await patch('settings', { name: 'stale', expectedUpdatedAt: 'old' })).status).toBe(409);
    expect(db.prepare('SELECT name FROM projects').get()).toEqual({ name: 'first' });
  });
  it('allows description clearing while preserving omitted name', async () => {
    expect(
      (await patch('profiles/profile', { description: null, expectedUpdatedAt: 'old' })).status
    ).toBe(200);
    expect(db.prepare('SELECT name, description FROM agent_profiles').get()).toEqual({
      name: 'Sol',
      description: null,
    });
  });
  it('denied project capability never changes a resource', async () => {
    auth.capability.mockRejectedValue(new AppError(403, 'FORBIDDEN', 'Denied'));
    expect((await patch('settings', { name: 'denied', expectedUpdatedAt: 'old' })).status).toBe(
      403
    );
    expect(db.prepare('SELECT name FROM projects').get()).toEqual({ name: 'original' });
  });
});

it('does not edit builtin skill metadata', async () => {
  auth.builtin = true;
  const response = await patch('skills/skill', { name: 'changed', expectedUpdatedAt: 'old' });
  expect(response.status).toBe(400);
});

describe('project rename identity', () => {
  it('stores the same normalized identity as ordinary project updates', async () => {
    const response = await patch('settings', { name: '  New   NAME  ', expectedUpdatedAt: 'old' });
    expect(response.status).toBe(200);
    expect(
      db.prepare('SELECT name, normalized_name FROM projects WHERE id = ?').get('project')
    ).toEqual({ name: 'New   NAME', normalized_name: 'new name' });
  });
  it('rejects another project owner name ignoring case and repeated whitespace', async () => {
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run(
      'other',
      'user',
      'Existing Name',
      'existing name',
      null,
      'old'
    );
    expect(
      (await patch('settings', { name: '  EXISTING   name ', expectedUpdatedAt: 'old' })).status
    ).toBe(409);
    expect(
      db
        .prepare('SELECT name, normalized_name, updated_at FROM projects WHERE id = ?')
        .get('project')
    ).toEqual({ name: 'original', normalized_name: 'original', updated_at: 'old' });
  });
  it('permits another owner to use the same name and preserves normalization on description-only edits', async () => {
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run(
      'other',
      'different-owner',
      'Shared',
      'shared',
      null,
      'old'
    );
    expect(
      (await patch('settings', { description: 'metadata only', expectedUpdatedAt: 'old' })).status
    ).toBe(200);
    const current = db
      .prepare('SELECT normalized_name, updated_at FROM projects WHERE id = ?')
      .get('project') as { normalized_name: string; updated_at: string };
    expect(current.normalized_name).toBe('original');
    expect(
      (await patch('settings', { name: 'Shared', expectedUpdatedAt: current.updated_at })).status
    ).toBe(200);
  });
});
