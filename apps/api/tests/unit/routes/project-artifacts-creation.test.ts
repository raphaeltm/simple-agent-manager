import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { registerProjectCreateRoute } from '../../../src/routes/projects/project-create';
import { registerArtifactsBackendFallback } from '../../../src/services/artifacts/backend';

/**
 * The Artifacts branch of `POST /api/projects` resolves its backend through
 * `resolveArtifactsBackend` (self-host landing slice L16): the Cloudflare binding on Cloudflare, or
 * the backend a self-host build registered. Real Hono route; D1 and README seeding mocked.
 */

const mocks = vi.hoisted(() => ({
  createOwnerProjectMembership: vi.fn(),
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
  seedArtifactsReadme: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({ getUserId: () => 'user-1' }));
vi.mock('../../../src/middleware/project-auth', () => ({
  createOwnerProjectMembership: mocks.createOwnerProjectMembership,
}));
vi.mock('../../../src/services/artifacts/seed-readme', () => ({
  seedArtifactsReadme: mocks.seedArtifactsReadme,
}));

function backend(remote: string) {
  return {
    create: vi.fn().mockResolvedValue({
      id: 'r1',
      name: 'hosted-project-r1',
      remote,
      token: 'write-token',
      default_branch: 'main',
    }),
    delete: vi.fn().mockResolvedValue(true),
    get: vi.fn(),
  };
}

describe('POST /api/projects — Artifacts provider through the hosted-git seam', () => {
  let app: Hono<{ Bindings: Env }>;
  let whereResponses: unknown[][];
  let limitResponses: unknown[][];
  let insertedRows: unknown[];
  let deletedProjectIds: unknown[];
  const mockEnv = { DATABASE: {} as D1Database } as Env;

  const createArtifactsProject = (
    env: Env,
    body: Record<string, unknown> = { name: 'Hosted Project', repoProvider: 'artifacts' }
  ) =>
    app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );

  beforeEach(() => {
    vi.clearAllMocks();
    whereResponses = [];
    limitResponses = [];
    insertedRows = [];
    deletedProjectIds = [];

    const mockDB = {
      select: vi.fn(() => ({
        from: () => ({
          where: () =>
            Object.assign(Promise.resolve(whereResponses.shift() ?? []), {
              limit: () => Promise.resolve(limitResponses.shift() ?? []),
            }),
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((row: unknown) => {
          insertedRows.push(row);
          return Promise.resolve(undefined);
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn((predicate: unknown) => {
          deletedProjectIds.push(predicate);
          return Promise.resolve(undefined);
        }),
      })),
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);

    mocks.seedArtifactsReadme.mockResolvedValue(undefined);
    mocks.createOwnerProjectMembership.mockResolvedValue(undefined);

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode)
        : c.json({ error: 'INTERNAL_ERROR' }, 500)
    );
    const createRoute = new Hono<{ Bindings: Env }>();
    registerProjectCreateRoute(createRoute);
    app.route('/api/projects', createRoute);
  });

  afterEach(() => registerArtifactsBackendFallback(null));

  it('creates the repository with the Cloudflare binding (unchanged), never the fallback', async () => {
    const remote = 'https://acct.artifacts.cloudflare.net/git/default/hosted-project-r1.git';
    const binding = backend(remote);
    const fallback = vi.fn();
    registerArtifactsBackendFallback(fallback);
    limitResponses.push([], [{ id: 'x', repository: remote }]);

    const res = await createArtifactsProject({
      ...mockEnv,
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: binding,
    } as Env);

    expect(res.status).toBe(201);
    expect(binding.create).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(insertedRows[0]).toMatchObject({ repoProvider: 'artifacts', repository: remote });
  });

  it('does not probe optional extension methods on a native RPC binding', async () => {
    const remote = 'https://acct.artifacts.cloudflare.net/git/default/hosted-project-r1.git';
    const binding = new Proxy(backend(remote), { get(target, property, receiver) {
      if (!(property in target)) return vi.fn().mockRejectedValue(new Error('Unknown RPC method'));
      return Reflect.get(target, property, receiver);
    } });
    limitResponses.push([], [{ id: 'x', repository: remote }]);
    mocks.seedArtifactsReadme.mockImplementationOnce(async (options) => {
      if (options.fetchImpl) await options.fetchImpl(options.remote);
    });
    const response = await createArtifactsProject({ ...mockEnv, ARTIFACTS_ENABLED: 'true', ARTIFACTS: binding } as Env);
    expect(response.status).toBe(201);
    expect(binding.create).toHaveBeenCalledOnce();
    expect(mocks.seedArtifactsReadme).toHaveBeenCalledWith(expect.objectContaining({ fetchImpl: undefined }));
  });

  it('creates the repository with a registered self-host backend when no binding exists', async () => {
    const remote = 'https://api.sam.example/git/hosted-project-r1.git';
    const hosted = backend(remote);
    registerArtifactsBackendFallback(() => hosted as never);
    limitResponses.push([], [{ id: 'x', repository: remote }]);

    const res = await createArtifactsProject({ ...mockEnv, ARTIFACTS_ENABLED: 'true' } as Env);

    expect(res.status).toBe(201);
    expect(hosted.create).toHaveBeenCalledTimes(1);
    expect(mocks.seedArtifactsReadme).toHaveBeenCalledWith(
      expect.objectContaining({ remote, token: 'write-token' })
    );
    expect(insertedRows[0]).toMatchObject({
      repoProvider: 'artifacts',
      repository: remote,
      artifactsRepoId: 'hosted-project-r1',
    });
  });

  it('deletes the new repository through the same backend when seeding fails', async () => {
    const hosted = backend('https://api.sam.example/git/hosted-project-r1.git');
    registerArtifactsBackendFallback(() => hosted as never);
    mocks.seedArtifactsReadme.mockRejectedValueOnce(new Error('push failed'));

    const res = await createArtifactsProject({ ...mockEnv, ARTIFACTS_ENABLED: 'true' } as Env);

    expect(res.status).toBe(500);
    expect(hosted.delete).toHaveBeenCalledWith('hosted-project-r1');
    expect(insertedRows).toHaveLength(0);
  });

  it('fails as before when Artifacts is enabled but no backend exists', async () => {
    const res = await createArtifactsProject({ ...mockEnv, ARTIFACTS_ENABLED: 'true' } as Env);
    expect(res.status).toBe(500);
    expect(insertedRows).toHaveLength(0);
  });

  it('refuses when the flag is off, even with a registered backend', async () => {
    const hosted = backend('https://api.sam.example/git/x.git');
    registerArtifactsBackendFallback(() => hosted as never);
    const res = await createArtifactsProject(mockEnv);
    expect(res.status).toBe(400);
    expect(hosted.create).not.toHaveBeenCalled();
  });
});
