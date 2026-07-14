import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  createWorkspaceOnNode: vi.fn(),
  signCallbackToken: vi.fn(),
  verifyNodeCallbackAuth: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  createWorkspaceOnNode: mocks.createWorkspaceOnNode,
}));
vi.mock('../../../src/services/jwt', () => ({
  shouldRefreshCallbackToken: vi.fn().mockReturnValue(false),
  signCallbackToken: mocks.signCallbackToken,
  signNodeCallbackToken: vi.fn(),
  signNodeManagementToken: vi.fn(),
}));
vi.mock('../../../src/services/node-callback-auth', () => ({
  verifyNodeCallbackAuth: mocks.verifyNodeCallbackAuth,
}));

import { drizzle } from 'drizzle-orm/d1';

import { nodeLifecycleRoutes } from '../../../src/routes/node-lifecycle';
import { scheduleWorkspaceCreateOnNode } from '../../../src/routes/workspaces/_helpers';

vi.mock('drizzle-orm/d1');

const gitlabProject = {
  id: 'project-gitlab-1',
  repoProvider: 'gitlab',
} as Pick<schema.Project, 'id' | 'repoProvider'>;

const gitlabMetadata = {
  userId: 'user-1',
  host: 'gitlab.example.com',
  gitlabProjectId: 123,
  pathWithNamespace: 'group/repository',
  webUrl: 'https://gitlab.example.com/group/repository',
  httpUrlToRepo: 'https://gitlab.example.com/group/repository.git',
  defaultBranch: 'main',
};

function makeDb(selectResults: unknown[][]) {
  const updates: unknown[] = [];

  return {
    updates,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = selectResults.shift() ?? [];
            return Object.assign(Promise.resolve(rows), {
              limit: vi.fn(() => Promise.resolve(rows)),
            });
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: unknown) => {
          updates.push(value);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    },
  };
}

function makeEnv() {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const bind = vi.fn(() => ({ run }));
  const env = {
    DATABASE: { prepare: vi.fn(() => ({ bind })) },
    BASE_DOMAIN: 'example.com',
  } as unknown as Env;
  return { env, bind, run };
}

describe('GitLab metadata propagation to VM workspace dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWorkspaceOnNode.mockResolvedValue({
      workspaceId: 'workspace-1',
      status: 'creating',
    });
    mocks.signCallbackToken.mockResolvedValue('workspace-callback-token');
    mocks.verifyNodeCallbackAuth.mockResolvedValue(undefined);
  });

  it('manual workspace creation passes GitLab clone metadata to the VM agent', async () => {
    const { db } = makeDb([[gitlabMetadata]]);
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db);
    const { env } = makeEnv();

    await scheduleWorkspaceCreateOnNode(
      env,
      'workspace-1',
      'node-1',
      'user-1',
      'group/repository',
      'main',
      gitlabProject,
      'User One',
      'user-1@example.com'
    );

    expect(mocks.createWorkspaceOnNode).toHaveBeenCalledWith(
      'node-1',
      env,
      'user-1',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        repository: 'group/repository',
        branch: 'main',
        repoProvider: 'gitlab',
        cloneUrl: 'https://gitlab.example.com/group/repository.git',
        repositoryHost: 'gitlab.example.com',
        repositoryPath: 'group/repository',
        callbackToken: 'workspace-callback-token',
        gitUserName: 'User One',
        gitUserEmail: 'user-1@example.com',
      })
    );
  });

  it('node-ready replay passes GitLab clone metadata to the VM agent', async () => {
    const pendingWorkspace = {
      id: 'workspace-1',
      userId: 'user-1',
      repository: 'group/repository',
      branch: 'main',
      projectId: gitlabProject.id,
      repoProvider: gitlabProject.repoProvider,
    };
    const { db } = makeDb([[pendingWorkspace], [gitlabProject], [gitlabMetadata]]);
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db);
    const { env } = makeEnv();
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => waitUntilPromises.push(promise)),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/nodes', nodeLifecycleRoutes);

    const response = await app.request(
      '/api/nodes/node-1/ready',
      { method: 'POST', headers: { Authorization: 'Bearer node-token' } },
      env,
      executionCtx
    );
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(200);
    expect(mocks.createWorkspaceOnNode).toHaveBeenCalledWith(
      'node-1',
      env,
      'user-1',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        repository: 'group/repository',
        branch: 'main',
        repoProvider: 'gitlab',
        cloneUrl: 'https://gitlab.example.com/group/repository.git',
        repositoryHost: 'gitlab.example.com',
        repositoryPath: 'group/repository',
        callbackToken: 'workspace-callback-token',
      })
    );
  });

  it('node-ready replay fails closed when a GitLab project has no metadata record', async () => {
    const pendingWorkspace = {
      id: 'workspace-1',
      userId: 'user-1',
      repository: 'group/repository',
      branch: 'main',
      projectId: gitlabProject.id,
      repoProvider: gitlabProject.repoProvider,
    };
    const { db, updates } = makeDb([[pendingWorkspace], [gitlabProject], []]);
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db);
    const { env } = makeEnv();
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => waitUntilPromises.push(promise)),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/nodes', nodeLifecycleRoutes);

    const response = await app.request(
      '/api/nodes/node-1/ready',
      { method: 'POST', headers: { Authorization: 'Bearer node-token' } },
      env,
      executionCtx
    );
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(200);
    expect(mocks.createWorkspaceOnNode).not.toHaveBeenCalled();
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: 'error',
        errorMessage: 'GitLab repository metadata is missing for project project-gitlab-1',
      })
    );
  });
});
