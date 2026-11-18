/**
 * C15 (self-host landing slice L16): an Artifacts project whose remote is not a Cloudflare Artifacts
 * host (a self-hosted install's own git server) gets cloneUrl + repositoryHost, so the VM agent
 * attaches the workspace's git token to exactly that host. Cloudflare Artifacts remotes, which every
 * production Artifacts project uses, are unchanged.
 *
 * Driven through `resolveWorkspaceGitSourceByProjectId` against a real SQL engine, so the test also
 * proves the clone URL comes from the project row the caller already reads (no extra query).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  resolveWorkspaceGitSource,
  resolveWorkspaceGitSourceByProjectId,
} from '../../../src/services/workspace-git-source';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let queries: string[];

function seedProject(id: string, repoProvider: string, repository: string): void {
  sqlite
    .prepare('INSERT INTO projects (id, repo_provider, repository) VALUES (?, ?, ?)')
    .run(id, repoProvider, repository);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.projects]);
  const d1 = createSqliteD1(sqlite);
  queries = [];
  const counting = {
    ...d1,
    prepare(sql: string) {
      queries.push(sql);
      return d1.prepare(sql);
    },
  } as D1Database;
  db = drizzle(counting, { schema });
});

afterEach(() => {
  sqlite.close();
});

describe('resolveWorkspaceGitSource for Artifacts projects', () => {
  it('leaves a Cloudflare Artifacts remote unchanged (no cloneUrl, no repositoryHost)', async () => {
    seedProject('p-cf', 'artifacts', 'https://acct123.artifacts.cloudflare.net/git/default/r.git');
    await expect(resolveWorkspaceGitSourceByProjectId(db, 'p-cf')).resolves.toEqual({
      repoProvider: 'artifacts',
      cloneUrl: null,
      repositoryHost: null,
      repositoryPath: null,
    });
  });

  it('binds a self-hosted git server remote as cloneUrl + repositoryHost', async () => {
    const remote = 'https://api.sam.example/git/demo-01abc.git';
    seedProject('p-hosted', 'artifacts', remote);
    await expect(resolveWorkspaceGitSourceByProjectId(db, 'p-hosted')).resolves.toEqual({
      repoProvider: 'artifacts',
      cloneUrl: remote,
      repositoryHost: 'api.sam.example',
      repositoryPath: null,
    });
    // One read: the project row the resolver already selected. C15 adds no query.
    expect(queries).toHaveLength(1);
  });

  it('keeps a non-default port in the bound host (the VM agent compares url.Host)', async () => {
    seedProject('p-port', 'artifacts', 'https://API.sam.example:8443/git/demo.git');
    const source = await resolveWorkspaceGitSourceByProjectId(db, 'p-port');
    expect(source.repositoryHost).toBe('api.sam.example:8443');
  });

  it('binds nothing for a malformed or non-https remote', async () => {
    seedProject('p-bad', 'artifacts', 'not a url');
    seedProject('p-http', 'artifacts', 'http://api.sam.example/git/demo.git');
    seedProject('p-empty', 'artifacts', '');
    for (const id of ['p-bad', 'p-http', 'p-empty']) {
      const source = await resolveWorkspaceGitSourceByProjectId(db, id);
      expect(source).toEqual({
        repoProvider: 'artifacts',
        cloneUrl: null,
        repositoryHost: null,
        repositoryPath: null,
      });
    }
  });

  it('does not treat a look-alike host as Cloudflare Artifacts', async () => {
    const remote = 'https://artifacts.cloudflare.net.evil.test/git/r.git';
    seedProject('p-lookalike', 'artifacts', remote);
    const source = await resolveWorkspaceGitSourceByProjectId(db, 'p-lookalike');
    expect(source.repositoryHost).toBe('artifacts.cloudflare.net.evil.test');
  });

  it('leaves GitHub projects unchanged, whatever their repository looks like', async () => {
    seedProject('p-gh', 'github', 'owner/repo');
    await expect(resolveWorkspaceGitSourceByProjectId(db, 'p-gh')).resolves.toEqual({
      repoProvider: 'github',
      cloneUrl: null,
      repositoryHost: null,
      repositoryPath: null,
    });
    // A GitHub project must never pick up an artifacts-style binding.
    await expect(
      resolveWorkspaceGitSource(db, {
        id: 'p-gh2',
        repoProvider: 'github',
        repository: 'https://api.sam.example/git/x.git',
      })
    ).resolves.toMatchObject({ repoProvider: 'github', cloneUrl: null, repositoryHost: null });
  });

  it('resolves from the repository the caller passes, without reading D1', async () => {
    const source = await resolveWorkspaceGitSource(db, {
      id: 'not-in-db',
      repoProvider: 'artifacts',
      repository: 'https://api.sam.example/git/demo.git',
    });
    expect(source.repositoryHost).toBe('api.sam.example');
    expect(queries).toHaveLength(0);
  });

  it('keeps Cloudflare behaviour for a NodeLifecycle request persisted before repository was passed', async () => {
    // Direct-provisioning inputs are stored in the NodeLifecycle DO; one written by the previous
    // deploy has { id, repoProvider } only.
    const legacy = { id: 'p-legacy', repoProvider: 'artifacts' } as unknown as Parameters<
      typeof resolveWorkspaceGitSource
    >[1];
    await expect(resolveWorkspaceGitSource(db, legacy)).resolves.toEqual({
      repoProvider: 'artifacts',
      cloneUrl: null,
      repositoryHost: null,
      repositoryPath: null,
    });
  });
});
