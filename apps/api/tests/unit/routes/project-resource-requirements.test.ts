import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { toProjectResponse } from '../../../src/lib/mappers';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { crudRoutes } from '../../../src/routes/projects/crud';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const OWNER = 'user-project-resource-requirements';
const PROJECT_ID = 'project-resource-requirements';
const NOW = '2026-09-07T00:00:00.000Z';

function authContext(): AuthContext {
  return {
    user: {
      id: OWNER,
      email: 'owner@example.test',
      name: 'Project owner',
      avatarUrl: null,
      role: 'user',
      status: 'active',
    },
    session: {
      id: 'session-owner',
      expiresAt: new Date('2026-09-08T00:00:00.000Z'),
    },
  };
}

function projectRow(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: PROJECT_ID,
    userId: OWNER,
    name: 'Resource Requirements Project',
    normalizedName: 'resource requirements project',
    description: null,
    installationId: null,
    repository: 'acme/repo',
    defaultBranch: 'main',
    repoProvider: 'github',
    artifactsRepoId: null,
    githubRepoId: null,
    githubRepoNodeId: null,
    defaultVmSize: null,
    resourceRequirementsJson: null,
    defaultAgentType: null,
    defaultWorkspaceProfile: null,
    defaultDevcontainerConfigName: null,
    defaultProvider: null,
    defaultLocation: null,
    agentDefaults: null,
    workspaceIdleTimeoutMs: null,
    nodeIdleTimeoutMs: null,
    taskExecutionTimeoutMs: null,
    maxConcurrentTasks: null,
    maxDispatchDepth: null,
    maxSubTasksPerTask: null,
    warmNodeTimeoutMs: null,
    maxWorkspacesPerNode: null,
    nodeCpuThresholdPercent: null,
    nodeMemoryThresholdPercent: null,
    maxTriggers: null,
    status: 'active',
    lastActivityAt: null,
    activeSessionCount: 0,
    createdBy: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as schema.Project;
}

describe('Project resourceRequirementsJson API contract', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function seedProject(resourceRequirementsJson: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, user_id, name, normalized_name, repository, default_branch, repo_provider, status, resource_requirements_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'main', 'github', 'active', ?, ?, ?, ?)`
      )
      .run(
        PROJECT_ID,
        OWNER,
        'Resource Requirements Project',
        'resource requirements project',
        'acme/repo',
        resourceRequirementsJson,
        OWNER,
        NOW,
        NOW
      );
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, 'owner', 'active', ?, ?)`
      )
      .run(PROJECT_ID, OWNER, NOW, NOW);
  }

  function readStoredResourceRequirements(): string | null {
    const row = sqlite
      .prepare(`SELECT resource_requirements_json FROM projects WHERE id = ?`)
      .get(PROJECT_ID) as { resource_requirements_json: string | null } | undefined;
    return row?.resource_requirements_json ?? null;
  }

  async function patchProject(body: Record<string, unknown>): Promise<Response> {
    return app.request(
      `/api/projects/${PROJECT_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );
  }

  async function getProject(): Promise<Response> {
    return app.request(`/api/projects/${PROJECT_ID}`, {}, env);
  }

  beforeEach(() => {
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

  it('persists normalized JSON from PATCH and returns it from GET detail', async () => {
    seedProject(null);

    const response = await patchProject({
      resourceRequirementsJson: '{"minVcpu":4,"minMemoryGb":16,"exclusiveNode":false}',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { resourceRequirementsJson: string | null };
    const expected = { minVcpu: 4, minMemoryGb: 16, exclusiveNode: false };
    expect(JSON.parse(body.resourceRequirementsJson as string)).toEqual(expected);
    expect(JSON.parse(readStoredResourceRequirements() as string)).toEqual(expected);

    const getResponse = await getProject();
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as { resourceRequirementsJson: string | null };
    expect(JSON.parse(getBody.resourceRequirementsJson as string)).toEqual(expected);
  });

  it('preserves the existing value when PATCH omits resourceRequirementsJson', async () => {
    const seeded = JSON.stringify({ minDiskGb: 80, maxCoTenants: 2 });
    seedProject(seeded);

    const response = await patchProject({ description: 'updated description' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { resourceRequirementsJson: string | null };
    expect(body.resourceRequirementsJson).toBe(seeded);
    expect(readStoredResourceRequirements()).toBe(seeded);
  });

  it('clears the project default when PATCH sets resourceRequirementsJson to null', async () => {
    seedProject(JSON.stringify({ minVcpu: 2 }));

    const response = await patchProject({ resourceRequirementsJson: null });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { resourceRequirementsJson: string | null };
    expect(body.resourceRequirementsJson).toBeNull();
    expect(readStoredResourceRequirements()).toBeNull();
  });

  it('rejects invalid resource requirements and leaves the stored value unchanged', async () => {
    const seeded = JSON.stringify({ minVcpu: 2 });
    seedProject(seeded);

    const malformedResponse = await patchProject({ resourceRequirementsJson: '{not json' });
    expect(malformedResponse.status).toBe(400);
    expect(readStoredResourceRequirements()).toBe(seeded);

    const invalidResponse = await patchProject({
      resourceRequirementsJson: '{"exclusiveNode":"false"}',
    });
    expect(invalidResponse.status).toBe(400);
    expect(readStoredResourceRequirements()).toBe(seeded);
  });
});

describe('Project resourceRequirementsJson mapper contract', () => {
  it('passes the raw project resourceRequirementsJson string through to API DTOs', () => {
    const raw = JSON.stringify({ minMemoryGb: 32, exclusiveNode: false });

    expect(
      toProjectResponse(projectRow({ resourceRequirementsJson: raw })).resourceRequirementsJson
    ).toBe(raw);
  });
});
