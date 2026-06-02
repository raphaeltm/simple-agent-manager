import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  devcontainerConfigRoutes,
  discoverGitHubDevcontainerConfigs,
  parseDevcontainerConfigs,
} from '../../../src/routes/projects/devcontainer-configs';

const MIXED_DEVCONTAINER_TREE = [
  { path: '.devcontainer/devcontainer.json', type: 'blob' },
  { path: '.devcontainer/python/devcontainer.json', type: 'blob' },
  { path: '.devcontainer/node/devcontainer.json', type: 'blob' },
  { path: 'src/main.ts', type: 'blob' },
];

const EXPECTED_NODE_PYTHON_CONFIGS = [
  { name: 'node', path: '.devcontainer/node/devcontainer.json' },
  { name: 'python', path: '.devcontainer/python/devcontainer.json' },
];

const INVALID_NAME_TREE = [
  { path: '.devcontainer/../evil/devcontainer.json', type: 'blob' },
  { path: '.devcontainer/valid-name/devcontainer.json', type: 'blob' },
  { path: '.devcontainer/-leading-hyphen/devcontainer.json', type: 'blob' },
];

const EXPECTED_VALID_NAME_CONFIGS = [
  { name: 'valid-name', path: '.devcontainer/valid-name/devcontainer.json' },
];

// =============================================================================
// Unit tests for parseDevcontainerConfigs (pure function)
// =============================================================================

describe('parseDevcontainerConfigs', () => {
  it('detects root .devcontainer.json as default config', () => {
    const tree = [{ path: '.devcontainer.json', type: 'blob' }];
    const result = parseDevcontainerConfigs(tree);
    expect(result.defaultConfigExists).toBe(true);
    expect(result.configs).toEqual([]);
  });

  it('detects .devcontainer/devcontainer.json as default config', () => {
    const tree = [{ path: '.devcontainer/devcontainer.json', type: 'blob' }];
    const result = parseDevcontainerConfigs(tree);
    expect(result.defaultConfigExists).toBe(true);
    expect(result.configs).toEqual([]);
  });

  it('detects named configs from .devcontainer/<name>/devcontainer.json', () => {
    const tree = [
      { path: '.devcontainer/python/devcontainer.json', type: 'blob' },
      { path: '.devcontainer/node/devcontainer.json', type: 'blob' },
    ];
    const result = parseDevcontainerConfigs(tree);
    expect(result.defaultConfigExists).toBe(false);
    expect(result.configs).toEqual([
      { name: 'node', path: '.devcontainer/node/devcontainer.json' },
      { name: 'python', path: '.devcontainer/python/devcontainer.json' },
    ]);
  });

  it('sorts named configs alphabetically', () => {
    const tree = [
      { path: '.devcontainer/zebra/devcontainer.json', type: 'blob' },
      { path: '.devcontainer/alpha/devcontainer.json', type: 'blob' },
      { path: '.devcontainer/middle/devcontainer.json', type: 'blob' },
    ];
    const result = parseDevcontainerConfigs(tree);
    expect(result.configs.map((c) => c.name)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('ignores tree entries for directories', () => {
    const tree = [
      { path: '.devcontainer/python', type: 'tree' },
      { path: '.devcontainer/python/devcontainer.json', type: 'blob' },
    ];
    const result = parseDevcontainerConfigs(tree);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.name).toBe('python');
  });

  it('ignores names with invalid characters', () => {
    const result = parseDevcontainerConfigs(INVALID_NAME_TREE);
    expect(result.configs).toEqual(EXPECTED_VALID_NAME_CONFIGS);
  });

  it('ignores names starting with hyphen or underscore', () => {
    const tree = [
      { path: '.devcontainer/-bad/devcontainer.json', type: 'blob' },
      { path: '.devcontainer/_bad/devcontainer.json', type: 'blob' },
      { path: '.devcontainer/good/devcontainer.json', type: 'blob' },
    ];
    const result = parseDevcontainerConfigs(tree);
    expect(result.configs).toEqual([
      { name: 'good', path: '.devcontainer/good/devcontainer.json' },
    ]);
  });

  it('ignores deeply nested devcontainer.json files', () => {
    const tree = [
      { path: '.devcontainer/deep/nested/devcontainer.json', type: 'blob' },
    ];
    const result = parseDevcontainerConfigs(tree);
    expect(result.configs).toEqual([]);
  });

  it('handles mixed default and named configs', () => {
    const result = parseDevcontainerConfigs(MIXED_DEVCONTAINER_TREE);
    expect(result.defaultConfigExists).toBe(true);
    expect(result.configs).toEqual(EXPECTED_NODE_PYTHON_CONFIGS);
  });

  it('returns empty for a tree with no devcontainer files', () => {
    const tree = [
      { path: 'src/main.ts', type: 'blob' },
      { path: 'README.md', type: 'blob' },
    ];
    const result = parseDevcontainerConfigs(tree);
    expect(result.defaultConfigExists).toBe(false);
    expect(result.configs).toEqual([]);
  });

  it('ignores names exceeding max length', () => {
    const longName = 'a'.repeat(129);
    const tree = [
      { path: `.devcontainer/${longName}/devcontainer.json`, type: 'blob' },
      { path: '.devcontainer/short/devcontainer.json', type: 'blob' },
    ];
    const result = parseDevcontainerConfigs(tree);
    expect(result.configs).toEqual([
      { name: 'short', path: '.devcontainer/short/devcontainer.json' },
    ]);
  });
});

describe('discoverGitHubDevcontainerConfigs', () => {
  it('returns no configs when the repo has no devcontainer files', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        tree: [{ path: 'src/main.ts', type: 'blob' }],
        truncated: false,
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await discoverGitHubDevcontainerConfigs('owner', 'repo', 'main', 'ghs_test');

    expect(result).toEqual({
      defaultConfigExists: false,
      configs: [],
      truncated: false,
    });
  });

  it('returns discovered default and named configs from the GitHub tree', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        tree: MIXED_DEVCONTAINER_TREE,
        truncated: false,
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await discoverGitHubDevcontainerConfigs('owner', 'repo', 'main', 'ghs_test');

    expect(result).toEqual({
      defaultConfigExists: true,
      configs: EXPECTED_NODE_PYTHON_CONFIGS,
      truncated: false,
    });
  });

  it('falls back to contents API when the recursive tree is truncated', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tree: [], truncated: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          { name: 'python', type: 'dir' },
          { name: 'notes.md', type: 'file' },
        ]), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await discoverGitHubDevcontainerConfigs('owner', 'repo', 'main', 'ghs_test');

    expect(result).toEqual({
      defaultConfigExists: false,
      configs: [{ name: 'python', path: '.devcontainer/python/devcontainer.json' }],
      truncated: true,
    });
  });
});

// =============================================================================
// Route integration tests
// =============================================================================

const mockRequireOwnedProject = vi.hoisted(() => vi.fn());
const mockRequireOwnedInstallation = vi.hoisted(() => vi.fn());
const mockGetInstallationToken = vi.hoisted(() => vi.fn());

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mockRequireOwnedProject,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireOwnedInstallation: mockRequireOwnedInstallation,
}));

vi.mock('../../../src/services/github-app', () => ({
  getInstallationToken: mockGetInstallationToken,
}));

const BASE_URL = 'https://api.test.example.com';

function makeEnv(): Env {
  return { DATABASE: {} as any } as Env;
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    userId: 'test-user-id',
    name: 'Test Project',
    repository: 'owner/repo',
    defaultBranch: 'main',
    repoProvider: 'github',
    installationId: 'install-row-1',
    ...overrides,
  };
}

function setupGithubProject(options: {
  token?: string;
  project?: Record<string, unknown>;
} = {}) {
  const token = options.token ?? 'ghs_test';
  mockRequireOwnedProject.mockResolvedValue(makeProject(options.project));
  mockRequireOwnedInstallation.mockResolvedValue({ installationId: '12345' });
  mockGetInstallationToken.mockResolvedValue({
    token,
    expiresAt: '2026-12-01T00:00:00Z',
  });
  return token;
}

function stubTreeResponse(tree: Array<{ path: string; type: string }>) {
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ tree, truncated: false }), { status: 200 }),
  );
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

async function requestConfigs(app: Hono<{ Bindings: Env }>) {
  return app.request(`${BASE_URL}/proj-1/devcontainer-configs`, {}, makeEnv());
}

describe('GET /projects/:projectId/devcontainer-configs', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: (err as Error).message }, 500);
    });
    app.route('/', devcontainerConfigRoutes);
  });

  it('returns named configs from a GitHub repo tree', async () => {
    setupGithubProject();
    stubTreeResponse(MIXED_DEVCONTAINER_TREE);

    const res = await requestConfigs(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('github');
    expect(body.repository).toBe('owner/repo');
    expect(body.branch).toBe('main');
    expect(body.defaultConfigExists).toBe(true);
    expect(body.configs).toEqual(EXPECTED_NODE_PYTHON_CONFIGS);
  });

  it('returns unsupported for non-GitHub projects', async () => {
    mockRequireOwnedProject.mockResolvedValue(makeProject({ repoProvider: 'artifacts' }));

    const res = await requestConfigs(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unsupported).toBe(true);
    expect(body.configs).toEqual([]);
  });

  it('enforces project ownership', async () => {
    mockRequireOwnedProject.mockRejectedValue(
      Object.assign(new Error('Project not found'), { statusCode: 404, error: 'NOT_FOUND' }),
    );

    const res = await requestConfigs(app);
    expect(res.status).toBe(404);
  });

  it('returns 502 when GitHub API fails', async () => {
    const token = setupGithubProject();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    ));

    const res = await requestConfigs(app);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('GITHUB_API_ERROR');
    // Must not contain the installation token
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('returns no named configs when only default exists', async () => {
    setupGithubProject();
    stubTreeResponse([{ path: '.devcontainer.json', type: 'blob' }]);

    const res = await requestConfigs(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.defaultConfigExists).toBe(true);
    expect(body.configs).toEqual([]);
  });

  it('filters out invalid config names', async () => {
    setupGithubProject();
    stubTreeResponse(INVALID_NAME_TREE);

    const res = await requestConfigs(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configs).toEqual(EXPECTED_VALID_NAME_CONFIGS);
  });

  it('does not leak tokens in error responses', async () => {
    const token = setupGithubProject({ token: 'ghs_secret_token_value' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const res = await requestConfigs(app);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(token);
  });
});
