import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  getUserId: vi.fn(() => 'user-1'),
  requireProjectAccess: vi.fn(),
  requireRepositoryUserAccess: vi.fn().mockResolvedValue(undefined),
  requireProjectInstallation: vi.fn().mockResolvedValue({ id: 'inst' }),
  getExternalInstallationId: vi.fn(() => 'ext-inst'),
  resolveRepoBrowser: vi.fn(),
}));

vi.mock('../../src/middleware/auth', () => ({ getUserId: mocks.getUserId }));
vi.mock('../../src/middleware/project-auth', () => ({ requireProjectAccess: mocks.requireProjectAccess }));
vi.mock('../../src/routes/projects/_helpers', () => ({
  requireProjectInstallation: mocks.requireProjectInstallation,
  requireRepositoryUserAccess: mocks.requireRepositoryUserAccess,
}));
vi.mock('../../src/services/github-installation-ids', () => ({
  getExternalInstallationId: mocks.getExternalInstallationId,
}));
vi.mock('../../src/services/repo-browse', () => ({ resolveRepoBrowser: mocks.resolveRepoBrowser }));

import { repoBrowseRoutes } from '../../src/routes/projects/repo-browse';

const project = {
  id: 'p1',
  repository: 'octo/repo',
  repoProvider: 'github',
  defaultBranch: 'main',
  installationId: 'inst',
};

function makeApp() {
  const app = new Hono();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as 400)
      : c.json({ error: 'INTERNAL', message: String(err) }, 500)
  );
  app.route('/', repoBrowseRoutes);
  return app;
}

const env = { DATABASE: {} } as unknown as Parameters<typeof repoBrowseRoutes.fetch>[1];

function browserStub(overrides: Record<string, unknown> = {}) {
  return {
    listBranches: vi.fn(),
    listTree: vi.fn(),
    getFile: vi.fn(),
    getRawFile: vi.fn(),
    compare: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserId.mockReturnValue('user-1');
  mocks.requireProjectAccess.mockResolvedValue(project);
  mocks.requireRepositoryUserAccess.mockResolvedValue(undefined);
});

describe('repo-browse routes', () => {
  it('enforces the user∩app access gate before serving', async () => {
    mocks.resolveRepoBrowser.mockResolvedValue(browserStub({ listBranches: vi.fn().mockResolvedValue({ branches: [], truncated: false }) }));
    await makeApp().request('/p1/repo/branches', {}, env);
    expect(mocks.requireRepositoryUserAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      project,
      'user-1'
    );
  });

  it('injects a rawUrl for binary files', async () => {
    mocks.resolveRepoBrowser.mockResolvedValue(
      browserStub({
        getFile: vi.fn().mockResolvedValue({
          ref: 'main', path: 'x.png', size: 10, isBinary: true, tooLarge: false, content: null, rawUrl: null,
        }),
      })
    );
    const res = await makeApp().request('/p1/repo/file?ref=main&path=x.png', {}, env);
    const body = await res.json();
    expect(body.rawUrl).toBe('/api/projects/p1/repo/raw?ref=main&path=x.png');
  });

  it('defaults compare base to the project default branch', async () => {
    const compare = vi.fn().mockResolvedValue({ base: 'main', head: 'feat', files: [], totalAdditions: 0, totalDeletions: 0, filesChanged: 0, truncated: false });
    mocks.resolveRepoBrowser.mockResolvedValue(browserStub({ compare }));
    await makeApp().request('/p1/repo/compare?head=feat', {}, env);
    expect(compare).toHaveBeenCalledWith('main', 'feat');
  });

  it('rejects missing ref / missing path / path traversal with 400', async () => {
    mocks.resolveRepoBrowser.mockResolvedValue(browserStub());
    const app = makeApp();
    expect((await app.request('/p1/repo/tree', {}, env)).status).toBe(400);
    expect((await app.request('/p1/repo/file?ref=main', {}, env)).status).toBe(400);
    expect((await app.request('/p1/repo/file?ref=main&path=../etc/passwd', {}, env)).status).toBe(400);
    expect((await app.request('/p1/repo/compare', {}, env)).status).toBe(400); // missing head
  });
});
