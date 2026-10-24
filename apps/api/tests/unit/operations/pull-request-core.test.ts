import { readFileSync } from 'node:fs';

import { canonicalProjectPullRequestUrl } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  ensurePullRequest,
  getPullRequestStates,
  upsertPullRequestSnapshot,
} from '../../../src/operations/pull-request-core';
import type { OperationContext } from '../../../src/operations/types';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ token: vi.fn(), setting: vi.fn() }));
vi.mock('../../../src/services/github-app', () => ({ getInstallationToken: mocks.token }));
vi.mock('../../../src/services/admin-settings', () => ({ resolveAdminSetting: mocks.setting }));

describe('pull request state refresh', () => {
  let sqlite: Database.Database;
  let env: Env;
  const originalFetch = globalThis.fetch;
  const repo = 'acme/widget';
  const url = (number: number) => `https://github.com/${repo}/pull/${number}`;
  const context = (jobs?: Promise<void>[]): OperationContext => ({
    env,
    actor: { userId: 'user', via: 'web', scopes: new Set(['sam.read']) },
    requestId: 'test',
    ...(jobs
      ? { execCtx: { waitUntil: (job: Promise<void>) => jobs.push(job) } as ExecutionContext }
      : {}),
  });

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, repository TEXT, repo_provider TEXT, installation_id TEXT);
      CREATE TABLE github_installations (id TEXT PRIMARY KEY, installation_id TEXT, external_installation_id TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY);`);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0206_pull_requests.sql', import.meta.url),
        'utf8'
      )
    );
    sqlite
      .prepare("INSERT INTO github_installations VALUES ('install', 'stored', 'external')")
      .run();
    sqlite.prepare("INSERT INTO projects VALUES ('p1', 'acme/widget', 'github', 'install')").run();
    sqlite.prepare("INSERT INTO projects VALUES ('p2', 'acme/widget', 'github', 'install')").run();
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    mocks.token.mockResolvedValue({ token: 'test-token' });
    mocks.setting.mockImplementation(
      (_env: Env, name: string) =>
        ({
          'operations.pullRequestRefreshCap': 2,
          'operations.pullRequestRefreshTtlSeconds': 30,
          'operations.pullRequestRefreshBudgetPerHour': 1,
          'operations.pullRequestRefreshBackoffSeconds': 60,
          'operations.pullRequestRefreshTimeoutMs': 10000,
        })[name as 'operations.pullRequestRefreshCap']
    );
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    sqlite.close();
    vi.clearAllMocks();
  });

  it('uses one canonical PR identity across case and trailing slash', () => {
    expect(
      canonicalProjectPullRequestUrl('https://github.com/Acme/Widget/pull/7/', 'acme/widget')
    ).toBe('https://github.com/acme/widget/pull/7');
    expect(
      canonicalProjectPullRequestUrl('https://github.com/else/other/pull/7', 'acme/widget')
    ).toBeNull();
  });

  function githubPr(number: number) {
    return {
      number,
      html_url: url(number),
      title: `PR ${number}`,
      state: 'open',
      draft: false,
      merged: false,
      head: { ref: 'topic', sha: 'a'.repeat(40) },
      base: { ref: 'main', repo: { full_name: repo } },
      user: { login: 'alice' },
      created_at: '2026-10-23T10:00:00Z',
      updated_at: '2026-10-23T10:01:00Z',
      merged_at: null,
      closed_at: null,
    };
  }

  it('reads more than 100 refs with one D1 statement and maps canonical URLs', async () => {
    await ensurePullRequest(env, 'p1', repo, url(1));
    await ensurePullRequest(env, 'p1', repo, url(125));
    sqlite
      .prepare(
        "UPDATE pull_requests SET last_synced_at = '2026-10-24T00:00:00Z', title = 'Stored ' || number WHERE project_id = 'p1'"
      )
      .run();
    const prepare = vi.spyOn(env.DATABASE, 'prepare');
    const refs = Array.from({ length: 125 }, (_, index) => ({ url: url(index + 1) }));
    refs.push({ url: 'https://github.com/Acme/Widget/pull/1/' });
    refs.push({ url: 'https://github.com/else/other/pull/126' });

    const states = await getPullRequestStates(context(), 'p1', refs);

    expect(Object.keys(states)).toHaveLength(125);
    expect(states[url(1)]).toMatchObject({ title: 'Stored 1' });
    expect(states[url(125)]).toMatchObject({ title: 'Stored 125' });
    expect(states[url(2)]).toBeNull();
    expect(states['https://github.com/else/other/pull/126']).toBeUndefined();
    const stateQueries = prepare.mock.calls.filter(([sql]) =>
      sql.includes('FROM pull_requests WHERE project_id = ? AND url IN')
    );
    expect(stateQueries).toHaveLength(1);
    expect(stateQueries[0][0]).toContain('json_each(?)');
  });

  it('prunes only the previous head checks when a pull request advances', async () => {
    const oldSha = 'a'.repeat(40);
    const otherSha = 'b'.repeat(40);
    await ensurePullRequest(env, 'p1', repo, url(1));
    await ensurePullRequest(env, 'p1', repo, url(2));
    sqlite
      .prepare('UPDATE pull_requests SET head_sha = ? WHERE project_id = ? AND number = ?')
      .run(oldSha, 'p1', 1);
    sqlite
      .prepare('UPDATE pull_requests SET head_sha = ? WHERE project_id = ? AND number = ?')
      .run(otherSha, 'p1', 2);
    const insertCheck = (sha: string) => {
      sqlite
        .prepare(
          `INSERT INTO pull_request_checks
           (project_id, repository, head_sha, check_key, state, updated_at)
           VALUES (?, ?, ?, ?, 'success', ?)`
        )
        .run('p1', repo, sha, sha, '2026-10-24T00:00:00Z');
    };
    insertCheck(oldSha);
    insertCheck(otherSha);
    await upsertPullRequestSnapshot(env, 'p1', {
      repository: repo,
      number: 1,
      url: url(1),
      title: 'Advanced',
      state: 'open',
      isDraft: false,
      headRef: 'topic',
      headSha: 'c'.repeat(40),
      baseRef: 'main',
      authorLogin: 'alice',
      mergedAt: null,
      closedAt: null,
      createdAt: '2026-10-23T10:00:00Z',
      updatedAt: '2026-10-24T00:01:00Z',
    });
    expect(sqlite.prepare('SELECT head_sha FROM pull_request_checks').all()).toEqual([
      { head_sha: otherSha },
    ]);
  });

  it('shares one installation budget across concurrent projects and caps each read', async () => {
    const fetchMock = vi.fn(async (requestUrl: string) =>
      Response.json(githubPr(Number(requestUrl.split('/').at(-1))))
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const jobs: Promise<void>[] = [];
    await Promise.all(
      ['p1', 'p2'].map((projectId) =>
        getPullRequestStates(
          context(jobs),
          projectId,
          [1, 2, 3].map((number) => ({ url: url(number) })),
          { refresh: 'single' }
        )
      )
    );
    await Promise.all(jobs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const refreshed = sqlite
      .prepare('SELECT project_id, number, title, state FROM pull_requests')
      .all() as Array<{ project_id: string; number: number; title: string; state: string }>;
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ title: `PR ${refreshed[0].number}`, state: 'open' });
    expect(
      (
        await getPullRequestStates(context(), refreshed[0].project_id, [
          { url: url(refreshed[0].number) },
        ])
      )[url(refreshed[0].number)]
    ).toMatchObject({ title: refreshed[0].title, stale: false });
    expect(
      sqlite
        .prepare('SELECT used FROM pull_request_refresh_budget WHERE installation_id = ?')
        .get('external')
    ).toEqual({ used: 1 });
  });

  it('marks an unchanged GitHub refresh fresh without spending budget again on the next read', async () => {
    await ensurePullRequest(env, 'p1', repo, url(8));
    const fetchMock = vi.fn(async () => Response.json(githubPr(8)));
    globalThis.fetch = fetchMock as typeof fetch;
    const firstJobs: Promise<void>[] = [];
    await getPullRequestStates(context(firstJobs), 'p1', [{ url: url(8) }], {
      refresh: 'single',
    });
    await Promise.all(firstJobs);
    sqlite
      .prepare(
        "UPDATE pull_requests SET last_synced_at = '2025-01-01T00:00:00Z' WHERE project_id = 'p1' AND number = 8"
      )
      .run();
    sqlite.prepare('UPDATE pull_request_refresh_budget SET used = 0').run();

    const secondJobs: Promise<void>[] = [];
    const stale = await getPullRequestStates(context(secondJobs), 'p1', [{ url: url(8) }], {
      refresh: 'single',
    });
    expect(stale[url(8)]?.stale).toBe(true);
    await Promise.all(secondJobs);
    const fresh = await getPullRequestStates(context(), 'p1', [{ url: url(8) }]);
    expect(fresh[url(8)]?.stale).toBe(false);
    expect(
      sqlite
        .prepare('SELECT last_synced_at FROM pull_requests WHERE project_id = ? AND number = ?')
        .get('p1', 8)
    ).toMatchObject({ last_synced_at: expect.not.stringContaining('2025-01-01') });
    const thirdJobs: Promise<void>[] = [];
    await getPullRequestStates(context(thirdJobs), 'p1', [{ url: url(8) }], {
      refresh: 'single',
    });
    expect(thirdJobs).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('backs off on GitHub rate limiting and returns last known state marked stale', async () => {
    await ensurePullRequest(env, 'p1', repo, url(4));
    sqlite
      .prepare(
        "UPDATE pull_requests SET last_synced_at = '2026-01-01T00:00:00Z', title = 'Older title' WHERE number = 4"
      )
      .run();
    expect((await getPullRequestStates(context(), 'p2', [{ url: url(4) }]))[url(4)]).toBeNull();
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } })
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const jobs: Promise<void>[] = [];
    const state = await getPullRequestStates(context(jobs), 'p1', [{ url: url(4) }], {
      refresh: 'single',
    });
    expect(state[url(4)]).toMatchObject({ title: 'Older title', stale: true });
    expect((await getPullRequestStates(context(), 'p1', [{ url: url(4) }]))[url(4)]).toMatchObject({
      stale: true,
    });
    await Promise.all(jobs);
    const nextJobs: Promise<void>[] = [];
    await getPullRequestStates(context(nextJobs), 'p2', [{ url: url(5) }], {
      refresh: 'single',
    });
    await Promise.all(nextJobs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const budget = sqlite
      .prepare('SELECT blocked_until FROM pull_request_refresh_budget WHERE installation_id = ?')
      .get('external') as { blocked_until: number };
    expect(budget.blocked_until).toBeGreaterThan(Date.now());
  });

  it('backs off on a secondary-limit 403 without rate-limit headers', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('secondary limit', { status: 403 })
    ) as typeof fetch;
    const jobs: Promise<void>[] = [];
    await getPullRequestStates(context(jobs), 'p1', [{ url: url(6) }], { refresh: 'single' });
    await Promise.all(jobs);
    const budget = sqlite
      .prepare('SELECT blocked_until FROM pull_request_refresh_budget WHERE installation_id = ?')
      .get('external') as { blocked_until: number };
    expect(budget.blocked_until).toBeGreaterThan(Date.now());
  });
});
