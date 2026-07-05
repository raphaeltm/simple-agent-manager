import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { projectMembersRoutes } from '../../../src/routes/projects/members';

const mocks = vi.hoisted(() => ({
  currentUserId: 'owner-user',
  requireProjectCapability: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => mocks.currentUserId,
}));
vi.mock('../../../src/middleware/project-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/project-auth')>();
  return {
    ...actual,
    requireProjectCapability: mocks.requireProjectCapability,
  };
});

type QueryResult = unknown[];

function makeProject(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'proj-1',
    userId: 'owner-user',
    name: 'Shared Project',
    normalizedName: 'shared-project',
    description: null,
    installationId: 'inst-1',
    repository: 'acme/repo',
    defaultBranch: 'main',
    repoProvider: 'github',
    artifactsRepoId: null,
    githubRepoId: 42,
    githubRepoNodeId: 'R_repo',
    defaultVmSize: null,
    defaultAgentType: 'claude-code',
    defaultWorkspaceProfile: null,
    defaultDevcontainerConfigName: null,
    defaultProvider: 'hetzner',
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
    status: 'active',
    lastActivityAt: null,
    activeSessionCount: 0,
    createdBy: 'creator-user',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeMember(
  userId: string,
  role: schema.ProjectMember['role'] = 'admin',
  status: schema.ProjectMember['status'] = 'active'
): schema.ProjectMember {
  return {
    projectId: 'proj-1',
    userId,
    role,
    status,
    invitedBy: role === 'owner' ? null : 'owner-user',
    removedAt: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

describe('project ownership transfer', () => {
  let app: Hono<{ Bindings: Env }>;
  let selectResults: QueryResult[];
  let batchStatements: Array<{ sql: string; bindings: unknown[] }>;
  let batchChanges: number[];

  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = 'owner-user';
    mocks.requireProjectCapability.mockResolvedValue(makeProject());
    selectResults = [];
    batchStatements = [];
    batchChanges = [1, 1, 1, 1];

    const makeSelectBuilder = () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve(selectResults.shift() ?? []));
      chain.orderBy = vi.fn(() => Promise.resolve(selectResults.shift() ?? []));
      chain.then = (
        resolve: (value: QueryResult) => unknown,
        reject: (reason?: unknown) => unknown
      ) => Promise.resolve(selectResults.shift() ?? []).then(resolve, reject);
      return chain;
    };
    const makeWritableBuilder = () => {
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn(() => chain);
      chain.values = vi.fn(() => Promise.resolve(undefined));
      chain.where = vi.fn(() => Promise.resolve(undefined));
      return chain;
    };

    const mockDb = {
      select: vi.fn(() => makeSelectBuilder()),
      update: vi.fn(() => makeWritableBuilder()),
      insert: vi.fn(() => makeWritableBuilder()),
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...bindings: unknown[]) => {
          const statement = { sql, bindings };
          batchStatements.push(statement);
          return statement as unknown as D1PreparedStatement;
        }),
      })),
      batch: vi.fn(async () =>
        batchChanges.map((changes) => ({
          results: [],
          success: true,
          meta: { changes },
        }))
      ),
    } as unknown as D1Database;
    env = {
      DATABASE: database,
      DEFAULT_TASK_AGENT_TYPE: 'claude-code',
    } as Env;

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', projectMembersRoutes);
  });

  async function transfer(toUserId = 'admin-user') {
    return app.request(
      '/api/projects/proj-1/ownership-transfer',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId, oldOwnerRole: 'admin' }),
      },
      env
    );
  }

  it('transfers ownership to an active admin and writes an audit row', async () => {
    selectResults = [[makeMember('admin-user', 'admin')]];

    const response = await transfer();
    const body = await response.json<ProjectOwnershipTransferResponseForTest>();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      projectId: 'proj-1',
      fromUserId: 'owner-user',
      toUserId: 'admin-user',
      fromRole: 'admin',
      toRole: 'owner',
    });
    expect(body.completedAt).toBeTruthy();
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'owner-user',
      'project:transfer_ownership'
    );

    expect(env.DATABASE.batch).toHaveBeenCalledTimes(1);
    expect(batchStatements).toHaveLength(4);
    expect(batchStatements[0]).toMatchObject({
      bindings: ['owner', body.completedAt, 'proj-1', 'admin-user'],
    });
    expect(batchStatements[1]).toMatchObject({
      bindings: ['admin', body.completedAt, 'proj-1', 'owner-user'],
    });
    expect(batchStatements[2]).toMatchObject({
      bindings: ['admin-user', body.completedAt, 'proj-1', 'owner-user'],
    });
    expect(batchStatements[2]?.sql).not.toContain('created_by');
    expect(batchStatements[3]).toMatchObject({
      bindings: [
        expect.any(String),
        'proj-1',
        'owner-user',
        'admin-user',
        'owner-user',
        body.completedAt,
        body.completedAt,
      ],
    });
  });

  it('defaults the old owner role to admin', async () => {
    selectResults = [[makeMember('admin-user', 'admin')]];

    const response = await app.request(
      '/api/projects/proj-1/ownership-transfer',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: 'admin-user' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(batchStatements[1]?.bindings[0]).toBe('admin');
  });

  it('rejects transfer to a non-member', async () => {
    selectResults = [[]];

    const response = await transfer();

    expect(response.status).toBe(404);
    expect(env.DATABASE.batch).not.toHaveBeenCalled();
  });

  it('rejects transfer to an inactive member', async () => {
    selectResults = [[makeMember('admin-user', 'admin', 'suspended')]];

    const response = await transfer();

    expect(response.status).toBe(404);
    expect(env.DATABASE.batch).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'maintainer'] as const)('rejects transfer to an active %s', async (role) => {
    selectResults = [[makeMember('admin-user', role)]];

    const response = await transfer();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
    });
    expect(env.DATABASE.batch).not.toHaveBeenCalled();
  });

  it('rejects transfer by a non-owner', async () => {
    mocks.currentUserId = 'admin-user';
    mocks.requireProjectCapability.mockRejectedValueOnce(
      Object.assign(new Error('Project capability is required'), {
        statusCode: 403,
        error: 'FORBIDDEN',
        message: 'Project capability is required',
      })
    );

    const response = await transfer('owner-user');

    expect(response.status).toBe(403);
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'admin-user',
      'project:transfer_ownership'
    );
    expect(env.DATABASE.batch).not.toHaveBeenCalled();
  });

  it('returns conflict when transfer state changes before the batch completes', async () => {
    selectResults = [[makeMember('admin-user', 'admin')]];
    batchChanges = [0, 1, 1, 1];

    const response = await transfer();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'CONFLICT',
    });
    expect(env.DATABASE.batch).toHaveBeenCalledTimes(1);
  });

  it('allows the old owner to be previewed for offboarding after transfer', async () => {
    selectResults = [
      [makeMember('admin-user', 'admin')],
      [makeMember('admin-user', 'owner'), makeMember('owner-user', 'admin')],
      [],
      [],
      [],
      [],
      [],
      [],
    ];

    const transferResponse = await transfer('admin-user');
    expect(transferResponse.status).toBe(200);

    mocks.currentUserId = 'admin-user';
    const previewResponse = await app.request(
      '/api/projects/proj-1/members/owner-user/offboarding-preview',
      { method: 'POST' },
      env
    );

    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      projectId: 'proj-1',
      memberUserId: 'owner-user',
      canApply: true,
      requiresHumanDecision: false,
    });
    expect(preview.error).not.toBe('last_owner_requires_transfer');
  });
});

interface ProjectOwnershipTransferResponseForTest {
  projectId: string;
  fromUserId: string;
  toUserId: string;
  fromRole: string;
  toRole: string;
  completedAt: string;
}
