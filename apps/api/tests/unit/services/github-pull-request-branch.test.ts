import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../src/db/schema';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { resolveProjectPullRequestHeadBranch } from '../../../src/services/github-pull-request-branch';
import { callMcpTool, createJsonKv, createMcpApp, storeMcpToken } from '../../helpers/mcp-route';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ access: vi.fn(), token: vi.fn(), fetch: vi.fn() }));
vi.mock('../../../src/routes/projects/_helpers', () => ({ requireRepositoryAccess: mocks.access }));
vi.mock('../../../src/services/github-app', () => ({ getInstallationToken: mocks.token }));
const env = {} as Env;
const project = { id: 'p', repository: 'Owner/Repo', repoProvider: 'github' } as Project;
const url = 'https://github.com/owner/repo/pull/42';
const payload = () => ({
  number: 42,
  head: { ref: 'actual-current-branch' },
  base: { repo: { full_name: 'Owner/Repo' } },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({
    installationId: 'internal',
    externalInstallationId: 'external',
  });
  mocks.token.mockResolvedValue({ token: 'existing-installation-token' });
  mocks.fetch.mockImplementation(async () => Response.json(payload()));
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('authorized current GitHub PR branch read', () => {
  it('reuses the existing access intersection before the installation read and validates PR identity', async () => {
    expect(await resolveProjectPullRequestHeadBranch(env, project, 'u', url)).toBe(
      'actual-current-branch'
    );
    expect(mocks.access).toHaveBeenCalledWith(env, expect.anything(), project, 'u');
    expect(mocks.token).toHaveBeenCalledWith('external', env);
    expect(mocks.access.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.token.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/repos/owner/repo/pulls/42',
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    );
  });

  it('uses the real resolver from authenticated MCP through the GitHub fetch boundary', async () => {
    const sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`INSERT INTO projects (id,user_id,name,repository,repo_provider,status) VALUES ('p','u','Project','owner/repo','github','active');
      INSERT INTO project_members (project_id,user_id,role,status) VALUES ('p','u','owner','active');
      INSERT INTO tasks (id,project_id,user_id,title,status,output_branch) VALUES ('owner','p','u','Owner','in_progress','caller-branch');
      INSERT INTO tasks (id,project_id,user_id,title,status,output_branch) VALUES ('competitor','p','u','Writer','in_progress','actual-current-branch');`);
    const routeEnv = { DATABASE: createSqliteD1(sqlite), KV: createJsonKv() } as Env;
    await storeMcpToken(routeEnv.KV, 'live-branch-token', {
      taskId: 'owner',
      projectId: 'p',
      userId: 'u',
      workspaceId: 'ws',
    });
    const app = await createMcpApp();
    const claim = (prHeadBranch: string) =>
      callMcpTool(app, routeEnv, 'live-branch-token', 'associate_pull_request', {
        prUrl: url,
        prHeadBranch,
        disposition: 'owned',
        reason: 'Assigned',
      });
    mocks.fetch.mockResolvedValueOnce(new Response('not accessible', { status: 403 }));
    expect((await claim('actual-current-branch')).error).toBeDefined();
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM task_pull_request_associations').get()
    ).toEqual({ n: 0 });
    expect((await claim('wrong-branch')).error).toBeDefined();
    expect((await claim('actual-current-branch')).error).toBeDefined();
    // GitHub changes its head between attempts: each claim must read again.
    mocks.fetch.mockImplementation(async () =>
      Response.json({ ...payload(), head: { ref: 'changed-current-branch' } })
    );
    sqlite
      .prepare("UPDATE tasks SET output_branch='changed-current-branch' WHERE id='competitor'")
      .run();
    expect((await claim('actual-current-branch')).error).toBeDefined();
    expect((await claim('changed-current-branch')).error).toBeDefined();
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM task_pull_request_associations').get()
    ).toEqual({ n: 0 });
    sqlite
      .prepare("UPDATE tasks SET output_branch='unrelated-parallel-branch' WHERE id='competitor'")
      .run();
    expect((await claim('changed-current-branch')).error).toBeUndefined();
    expect(
      sqlite.prepare('SELECT task_id,pr_url FROM task_pull_request_associations').all()
    ).toEqual([{ task_id: 'owner', pr_url: url }]);
    expect(mocks.access).toHaveBeenCalledWith(
      routeEnv,
      expect.anything(),
      expect.objectContaining({ id: 'p' }),
      'u'
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls/42',
      expect.anything()
    );
    sqlite.close();
  }, 30_000);

  it('refuses revoked repository access before token minting or PR reads', async () => {
    mocks.access.mockRejectedValueOnce(new Error('Repository access revoked'));
    await expect(resolveProjectPullRequestHeadBranch(env, project, 'u', url)).rejects.toThrow(
      'revoked'
    );
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308, 403, 404, 500])(
    'fails closed for GitHub HTTP %s without returning provider content',
    async (status) => {
      mocks.fetch.mockResolvedValueOnce(new Response('private-provider-detail', { status }));
      await expect(resolveProjectPullRequestHeadBranch(env, project, 'u', url)).rejects.toThrow(
        'Cannot verify'
      );
    }
  );

  it.each([
    { ...payload(), number: 420 },
    { ...payload(), base: { repo: { full_name: 'other/repo' } } },
    { ...payload(), head: { ref: '' } },
    { ...payload(), head: null },
  ])('refuses mismatched or missing PR branch identity', async (body) => {
    mocks.fetch.mockResolvedValueOnce(Response.json(body));
    await expect(resolveProjectPullRequestHeadBranch(env, project, 'u', url)).rejects.toThrow();
  });
});
