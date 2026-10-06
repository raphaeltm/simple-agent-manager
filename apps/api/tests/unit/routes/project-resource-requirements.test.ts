import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listActivityEvents: vi.fn(),
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../../src/services/project-data', () => ({
  listSessions: mocks.listSessions,
  listActivityEvents: mocks.listActivityEvents,
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

const { crudRoutes } = await import('../../../src/routes/projects/crud');

const OWNER = 'project-resource-owner';
const PROJECT = 'project-resource-project';

describe('project resource requirements routes', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function authContext(): AuthContext {
    return {
      user: {
        id: OWNER,
        email: 'owner@example.test',
        name: 'Project resource owner',
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: {
        id: 'session-project-resource-owner',
        expiresAt: new Date('2026-09-07T00:00:00.000Z'),
      },
    };
  }

  function addProject(resourceRequirementsJson: string | null = null): void {
    sqlite
      .prepare(
        `INSERT INTO projects (
           id, user_id, name, normalized_name, repo_provider, artifacts_repo_id,
           installation_id, repository, default_branch, status, created_by,
           resource_requirements_json, created_at, updated_at
         )
         VALUES (
           ?, ?, 'Resource Project', 'resource-project', 'artifacts', 'artifact-repo-1',
           'system_artifacts_installation', 'https://example.test/resource-project.git',
           'main', 'active', ?, ?, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'
         )`
      )
      .run(PROJECT, OWNER, OWNER, resourceRequirementsJson);
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES (?, ?, 'owner', 'active')`
      )
      .run(PROJECT, OWNER);
  }

  function storedResourceRequirementsJson(): string | null {
    return (
      sqlite
        .prepare(`SELECT resource_requirements_json FROM projects WHERE id = ?`)
        .get(PROJECT) as { resource_requirements_json: string | null }
    ).resource_requirements_json;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSessions.mockResolvedValue({ sessions: [] });
    mocks.listActivityEvents.mockResolvedValue({ events: [] });
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('auth', authContext());
      await next();
    });
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/projects', crudRoutes);
  });

  afterEach(() => sqlite.close());

  it('returns persisted project resource requirements on GET', async () => {
    addProject(JSON.stringify({ minVcpu: 2, exclusiveNode: false, minDiskGb: 0 }));

    const response = await app.request(`/api/projects/${PROJECT}`, { method: 'GET' }, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { resourceRequirementsJson: string | null };
    expect(JSON.parse(body.resourceRequirementsJson ?? '{}')).toEqual({
      minVcpu: 2,
      exclusiveNode: false,
      minDiskGb: 0,
    });
  });

  it('normalizes and persists project resource requirements on PATCH', async () => {
    addProject();

    const response = await app.request(
      `/api/projects/${PROJECT}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceRequirementsJson: JSON.stringify({
            minVcpu: 4,
            exclusiveNode: false,
            minDiskGb: 0,
          }),
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { resourceRequirementsJson: string | null };
    expect(JSON.parse(body.resourceRequirementsJson ?? '{}')).toEqual({
      minVcpu: 4,
      exclusiveNode: false,
      minDiskGb: 0,
    });
    expect(JSON.parse(storedResourceRequirementsJson() ?? '{}')).toEqual({
      minVcpu: 4,
      exclusiveNode: false,
      minDiskGb: 0,
    });
  });

  it('preserves omitted project resource requirements and clears explicit null', async () => {
    addProject(JSON.stringify({ minVcpu: 2 }));

    const preserveResponse = await app.request(
      `/api/projects/${PROJECT}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Resource Project' }),
      },
      env
    );

    expect(preserveResponse.status).toBe(200);
    expect(JSON.parse(storedResourceRequirementsJson() ?? '{}')).toEqual({ minVcpu: 2 });

    const clearResponse = await app.request(
      `/api/projects/${PROJECT}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirementsJson: null }),
      },
      env
    );

    expect(clearResponse.status).toBe(200);
    expect(storedResourceRequirementsJson()).toBeNull();
  });

  it('rejects malformed JSON strings and invalid bounds without changing storage', async () => {
    addProject(JSON.stringify({ minVcpu: 2 }));

    const malformedResponse = await app.request(
      `/api/projects/${PROJECT}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirementsJson: '{malformed' }),
      },
      env
    );

    expect(malformedResponse.status).toBe(400);
    expect((await malformedResponse.json()).message).toContain('resourceRequirementsJson');
    expect(JSON.parse(storedResourceRequirementsJson() ?? '{}')).toEqual({ minVcpu: 2 });

    const boundsResponse = await app.request(
      `/api/projects/${PROJECT}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirementsJson: JSON.stringify({ minVcpu: 0 }) }),
      },
      env
    );

    expect(boundsResponse.status).toBe(400);
    expect((await boundsResponse.json()).message).toContain('minVcpu');
    expect(JSON.parse(storedResourceRequirementsJson() ?? '{}')).toEqual({ minVcpu: 2 });
  });

  it('rejects object payloads for the public JSON-string field without changing storage', async () => {
    addProject(JSON.stringify({ minVcpu: 2 }));

    const response = await app.request(
      `/api/projects/${PROJECT}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirementsJson: { minVcpu: 4 } }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(storedResourceRequirementsJson() ?? '{}')).toEqual({ minVcpu: 2 });
  });
});
