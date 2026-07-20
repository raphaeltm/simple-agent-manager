import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { projectsRoutes } from '../../../src/routes/projects';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  requireProjectCapability: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'member-user',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.requireProjectCapability,
}));

describe('projects runtime config shared project rows', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE project_runtime_env_vars (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        env_key TEXT NOT NULL,
        stored_value TEXT NOT NULL,
        value_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX idx_project_runtime_env_project_key
        ON project_runtime_env_vars (project_id, env_key);

      CREATE TABLE project_runtime_files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stored_content TEXT NOT NULL,
        content_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    sqlite.exec(`
      INSERT INTO project_runtime_env_vars
        (id, project_id, user_id, env_key, stored_value, value_iv, is_secret)
      VALUES
        ('env-1', 'proj-1', 'owner-user', 'PROJECT_TOKEN', 'old-value', NULL, 0);
    `);

    mocks.requireProjectCapability.mockResolvedValue({
      id: 'proj-1',
      userId: 'owner-user',
      installationId: 'inst-1',
      repository: 'acme/repo',
      defaultBranch: 'main',
    });

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', projectsRoutes);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('updates an existing project env var when a project member edits an owner-created row', async () => {
    const res = await app.request(
      '/api/projects/proj-1/runtime/env-vars',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'PROJECT_TOKEN', value: 'new-value', isSecret: false }),
      },
      {
        DATABASE: createSqliteD1(sqlite),
        ENCRYPTION_KEY: 'test-key',
      } as Env
    );

    expect(res.status).toBe(200);
    const rows = sqlite
      .prepare('SELECT project_id, user_id, env_key, stored_value FROM project_runtime_env_vars')
      .all();
    expect(rows).toEqual([
      {
        project_id: 'proj-1',
        user_id: 'owner-user',
        env_key: 'PROJECT_TOKEN',
        stored_value: 'new-value',
      },
    ]);
  });
});
