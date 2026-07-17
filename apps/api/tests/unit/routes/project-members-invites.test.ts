import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { projectsRoutes } from '../../../src/routes/projects';

const mocks = vi.hoisted(() => ({
  currentUserId: 'member-user',
  getGitHubUserAccessTokenForOwner: vi.fn(),
  getGitHubUserAccessTokenWithHeaders: vi.fn(),
  getUserInstallationRepositories: vi.fn(),
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => mocks.currentUserId,
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/github-user-access-token', () => ({
  getGitHubUserAccessTokenForOwner: mocks.getGitHubUserAccessTokenForOwner,
  getGitHubUserAccessTokenWithHeaders: mocks.getGitHubUserAccessTokenWithHeaders,
}));
vi.mock('../../../src/services/github-app', () => ({
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
}));

type QueryResult = unknown[];

function makeProject(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'proj-1',
    userId: 'owner-user',
    name: 'Shared Project',
    normalizedName: 'shared project',
    description: null,
    installationId: 'inst-row-1',
    repository: 'acme/repo',
    defaultBranch: 'main',
    repoProvider: 'github',
    artifactsRepoId: null,
    githubRepoId: 42,
    githubRepoNodeId: 'R_repo',
    defaultVmSize: null,
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
    status: 'active',
    lastActivityAt: null,
    activeSessionCount: 0,
    createdBy: 'owner-user',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeInviteLink(
  overrides: Partial<schema.ProjectInviteLink> = {}
): schema.ProjectInviteLink {
  return {
    id: 'invite-1',
    projectId: 'proj-1',
    tokenHash: 'hash',
    createdBy: 'member-user',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null,
    useCount: 0,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<schema.ProjectAccessRequest> = {}
): schema.ProjectAccessRequest {
  return {
    id: 'request-1',
    projectId: 'proj-1',
    inviteLinkId: 'invite-1',
    requesterUserId: 'requester-user',
    status: 'pending',
    githubAccessStatus: 'verified',
    githubAccessCheckedAt: '2026-07-04T00:00:00.000Z',
    githubAccessMessage: null,
    requestedAt: '2026-07-04T00:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeRequestWithUser(request = makeRequest()) {
  return {
    request,
    userId: request.requesterUserId,
    name: 'Requester',
    email: 'requester@example.com',
    image: null,
    avatarUrl: 'https://example.com/avatar.png',
  };
}

function makeMember(overrides: Partial<schema.ProjectMember> = {}): schema.ProjectMember {
  return {
    projectId: 'proj-1',
    userId: 'requester-user',
    role: 'admin',
    status: 'active',
    invitedBy: 'owner-user',
    removedAt: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeInstallation(): schema.GitHubInstallation {
  return {
    id: 'inst-row-1',
    userId: 'owner-user',
    installationId: 'owner:123',
    externalInstallationId: '123',
    accountType: 'organization',
    accountName: 'acme',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
  };
}

describe('project invite links and access requests', () => {
  let app: Hono<{ Bindings: Env }>;
  let selectResults: QueryResult[];
  let insertedRows: Array<{ table: unknown; values: unknown }>;
  let updatedRows: Array<{ table: unknown; values: Record<string, unknown> }>;
  let conflictUpdates: unknown[];
  let insertReturning: QueryResult[];
  let updateReturning: QueryResult[];

  const env = {
    DATABASE: {} as D1Database,
    ENCRYPTION_KEY: 'test-encryption-key',
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = 'member-user';
    selectResults = [];
    insertedRows = [];
    updatedRows = [];
    conflictUpdates = [];
    insertReturning = [];
    updateReturning = [];

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

    const mockDb = {
      select: vi.fn(() => makeSelectBuilder()),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: unknown) => {
          insertedRows.push({ table, values });
          const returning = vi.fn(() =>
            Promise.resolve(insertReturning.shift() ?? [{ id: (values as { id?: string }).id }])
          );
          return {
            onConflictDoUpdate: vi.fn((config: unknown) => {
              conflictUpdates.push(config);
              return Promise.resolve(undefined);
            }),
            onConflictDoNothing: vi.fn(() => ({ returning })),
            then: (resolve: () => unknown) => Promise.resolve(undefined).then(resolve),
          };
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedRows.push({ table, values });
          const updateChain = {
            where: vi.fn(() => updateChain),
            returning: vi.fn(() => Promise.resolve(updateReturning.shift() ?? [])),
            then: (resolve: () => unknown) => Promise.resolve(undefined).then(resolve),
          };
          return updateChain;
        }),
      })),
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

    const project = makeProject();
    mocks.requireProjectAccess.mockResolvedValue(project);
    mocks.requireProjectCapability.mockResolvedValue(project);
    mocks.getGitHubUserAccessTokenWithHeaders.mockResolvedValue('requester-token');
    mocks.getGitHubUserAccessTokenForOwner.mockResolvedValue('requester-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([
      {
        id: 42,
        nodeId: 'R_repo',
        fullName: 'acme/repo',
        private: true,
        defaultBranch: 'main',
      },
    ]);

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

  it('lets any active project member create an invite link', async () => {
    const response = await app.request(
      '/api/projects/proj-1/invite-links',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays: 3 }),
      },
      env
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ token: string; status: string; expiresAt: string }>();
    expect(body.token).toMatch(/^sam_inv_/);
    expect(body.status).toBe('active');
    expect(body.expiresAt).toBeTruthy();
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'member-user'
    );
    expect(insertedRows[0]).toMatchObject({
      table: schema.projectInviteLinks,
      values: expect.objectContaining({
        projectId: 'proj-1',
        createdBy: 'member-user',
      }),
    });
    expect(String((insertedRows[0]?.values as { tokenHash?: string }).tokenHash)).not.toContain(
      body.token
    );
  });

  it('hides pending access requests from active members without member management capability', async () => {
    mocks.currentUserId = 'viewer-user';
    selectResults.push(
      [
        {
          member: {
            projectId: 'proj-1',
            userId: 'viewer-user',
            role: 'viewer',
            status: 'active',
            invitedBy: 'owner-user',
            createdAt: '2026-07-04T00:00:00.000Z',
            updatedAt: '2026-07-04T00:00:00.000Z',
          },
          userId: 'viewer-user',
          name: 'Viewer',
          email: 'viewer@example.com',
          image: null,
          avatarUrl: null,
        },
      ],
      [makeInviteLink()]
    );

    const response = await app.request('/api/projects/proj-1/members', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json<{
      accessRequests: unknown[];
      inviteLinks: unknown[];
      members: unknown[];
    }>();
    expect(body.members).toHaveLength(1);
    expect(body.inviteLinks).toHaveLength(1);
    expect(body.accessRequests).toEqual([]);
  });

  it('lets an authenticated non-member request access through a valid invite link', async () => {
    mocks.currentUserId = 'requester-user';
    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [],
      [],
      [makeInstallation()],
      [makeRequestWithUser()]
    );

    const response = await app.request(
      '/api/projects/invite-links/sam_inv_valid/request',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ status: string; githubAccessStatus: string }>();
    expect(body.status).toBe('pending');
    expect(body.githubAccessStatus).toBe('verified');
    expect(insertedRows).toContainEqual(
      expect.objectContaining({
        table: schema.projectAccessRequests,
        values: expect.objectContaining({
          projectId: 'proj-1',
          requesterUserId: 'requester-user',
          status: 'pending',
          githubAccessStatus: 'verified',
        }),
      })
    );
    expect(updatedRows).toContainEqual(
      expect.objectContaining({ table: schema.projectInviteLinks })
    );
  });

  it('rejects approval when the actor lacks member management capability', async () => {
    mocks.requireProjectCapability.mockRejectedValueOnce(
      Object.assign(new Error('Project capability is required'), {
        statusCode: 403,
        error: 'FORBIDDEN',
        message: 'Project capability is required',
      })
    );

    const response = await app.request(
      '/api/projects/proj-1/access-requests/request-1/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      env
    );

    expect(response.status).toBe(403);
    expect(insertedRows).toHaveLength(0);
  });

  it('lets an admin approve a pending request and creates an active admin membership', async () => {
    mocks.currentUserId = 'admin-user';
    selectResults.push(
      [makeRequest()],
      [makeInstallation()],
      [
        makeRequestWithUser(
          makeRequest({
            status: 'approved',
            decidedBy: 'admin-user',
            decidedAt: '2026-07-04T01:00:00.000Z',
          })
        ),
      ]
    );

    const response = await app.request(
      '/api/projects/proj-1/access-requests/request-1/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'approved' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'admin-user',
      'member:manage'
    );
    expect(insertedRows).toContainEqual(
      expect.objectContaining({
        table: schema.projectMembers,
        values: expect.objectContaining({
          projectId: 'proj-1',
          userId: 'requester-user',
          role: 'admin',
          status: 'active',
          invitedBy: 'admin-user',
        }),
      })
    );
    expect(conflictUpdates).toHaveLength(1);
    const body = await response.json<{ status: string; githubAccessStatus: string }>();
    expect(body.status).toBe('approved');
    expect(body.githubAccessStatus).toBe('verified');
  });

  it('records a denied request without adding a project member', async () => {
    mocks.currentUserId = 'admin-user';
    updateReturning.push([makeRequest({ status: 'denied', decidedBy: 'admin-user' })]);
    selectResults.push([makeRequestWithUser(makeRequest({ status: 'denied' }))]);

    const response = await app.request(
      '/api/projects/proj-1/access-requests/request-1/deny',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'not now' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(insertedRows).toHaveLength(0);
    const update = updatedRows.find((row) => row.table === schema.projectAccessRequests);
    expect(update?.values).toMatchObject({
      status: 'denied',
      decidedBy: 'admin-user',
      decisionNote: 'not now',
    });
  });

  it('rejects requests through revoked or expired invite links', async () => {
    mocks.currentUserId = 'requester-user';
    selectResults.push([
      {
        link: makeInviteLink({ revokedAt: '2026-07-04T00:00:00.000Z' }),
        project: makeProject(),
      },
    ]);

    const response = await app.request(
      '/api/projects/invite-links/sam_inv_revoked/request',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(400);
    expect(insertedRows).toHaveLength(0);
  });

  it('persists a no-access GitHub status on access requests instead of widening credentials', async () => {
    mocks.currentUserId = 'requester-user';
    mocks.getUserInstallationRepositories.mockResolvedValueOnce([
      {
        id: 99,
        nodeId: 'R_other',
        fullName: 'acme/other',
        private: true,
        defaultBranch: 'main',
      },
    ]);
    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [],
      [],
      [makeInstallation()],
      [makeRequestWithUser(makeRequest({ githubAccessStatus: 'no-access' }))]
    );

    const response = await app.request(
      '/api/projects/invite-links/sam_inv_valid/request',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(201);
    expect(insertedRows).toContainEqual(
      expect.objectContaining({
        table: schema.projectAccessRequests,
        values: expect.objectContaining({
          githubAccessStatus: 'no-access',
          githubAccessMessage: 'Requester does not have GitHub access to the project repository.',
        }),
      })
    );
    expect(insertedRows.some((row) => row.table === schema.projectMembers)).toBe(false);
  });

  it('derives removed-member preview from active membership instead of approved history', async () => {
    mocks.currentUserId = 'requester-user';
    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [makeMember({ status: 'removed', removedAt: '2026-07-06T11:21:29.000Z' })],
      [
        makeRequestWithUser(
          makeRequest({ status: 'approved', decidedAt: '2026-07-06T11:01:20.000Z' })
        ),
      ]
    );
    const response = await app.request('/api/projects/invite-links/sam_inv_valid', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      membershipStatus: 'can-request',
      accessRequest: { status: 'approved', decidedAt: '2026-07-06T11:01:20.000Z' },
    });
  });

  it('resets approved history to pending so approval can reactivate removed membership', async () => {
    mocks.currentUserId = 'requester-user';
    const approved = makeRequest({ status: 'approved', decidedBy: 'owner-user' });
    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [makeMember({ status: 'removed', removedAt: '2026-07-06T11:21:29.000Z' })],
      [makeRequestWithUser(approved)]
    );
    const preview = await app.request('/api/projects/invite-links/sam_inv_valid', {}, env);
    expect(await preview.json()).toMatchObject({ membershipStatus: 'can-request' });

    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [],
      [approved],
      [makeInstallation()],
      [makeRequestWithUser(makeRequest())]
    );
    updateReturning.push([{ id: 'request-1' }]);
    const response = await app.request(
      '/api/projects/invite-links/sam_inv_valid/request',
      { method: 'POST' },
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'pending' });
    expect(
      updatedRows.find((row) => row.table === schema.projectAccessRequests)?.values
    ).toMatchObject({ status: 'pending', decidedAt: null, decidedBy: null, decisionNote: null });

    mocks.currentUserId = 'admin-user';
    selectResults.push(
      [makeRequest()],
      [makeInstallation()],
      [makeRequestWithUser(makeRequest({ status: 'approved' }))]
    );
    const approval = await app.request(
      '/api/projects/proj-1/access-requests/request-1/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      env
    );
    expect(approval.status).toBe(200);
    expect(conflictUpdates).toContainEqual(
      expect.objectContaining({
        set: expect.objectContaining({ role: 'admin', status: 'active', invitedBy: 'admin-user' }),
      })
    );

    mocks.currentUserId = 'requester-user';
    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [makeMember({ invitedBy: 'admin-user' })],
      [makeRequestWithUser(makeRequest({ status: 'approved', decidedBy: 'admin-user' }))]
    );
    const activePreview = await app.request('/api/projects/invite-links/sam_inv_valid', {}, env);
    expect(await activePreview.json()).toMatchObject({ membershipStatus: 'active-member' });
  });

  it('returns a pending request idempotently without rechecking access or consuming the invite', async () => {
    mocks.currentUserId = 'requester-user';
    const pending = makeRequest();
    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [],
      [pending],
      [makeRequestWithUser(pending)]
    );
    const response = await app.request(
      '/api/projects/invite-links/sam_inv_valid/request',
      { method: 'POST' },
      env
    );
    expect(response.status).toBe(200);
    expect(mocks.getUserInstallationRepositories).not.toHaveBeenCalled();
    expect(updatedRows).toEqual([]);
  });

  it('does not overwrite a concurrently approved request', async () => {
    mocks.currentUserId = 'requester-user';
    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [],
      [makeRequest({ status: 'denied' })],
      [makeInstallation()],
      [makeMember()],
      [makeRequest({ status: 'approved' })]
    );
    updateReturning.push([]);
    const response = await app.request(
      '/api/projects/invite-links/sam_inv_valid/request',
      { method: 'POST' },
      env
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      message: 'You are already a member of this project',
    });
    expect(updatedRows.filter((row) => row.table === schema.projectInviteLinks)).toHaveLength(0);
  });

  it('returns the winning pending request when concurrent first requests share the unique key', async () => {
    mocks.currentUserId = 'requester-user';
    const pending = makeRequest();
    selectResults.push(
      [{ link: makeInviteLink(), project: makeProject() }],
      [],
      [],
      [makeInstallation()],
      [pending],
      [makeRequestWithUser(pending)]
    );
    insertReturning.push([]);
    const response = await app.request(
      '/api/projects/invite-links/sam_inv_valid/request',
      { method: 'POST' },
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'request-1', status: 'pending' });
    expect(updatedRows.filter((row) => row.table === schema.projectInviteLinks)).toHaveLength(0);
  });
});
