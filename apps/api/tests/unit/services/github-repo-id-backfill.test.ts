import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRepositoryMetadata: vi.fn(),
  getInstallationToken: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({ log: mocks.log }));
vi.mock('../../../src/services/github-app', () => ({
  getRepositoryMetadata: mocks.getRepositoryMetadata,
  getInstallationToken: mocks.getInstallationToken,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  backfillProjectGithubRepoId,
  bulkBackfillGithubRepoIds,
} from '../../../src/services/github-repo-id-backfill';

const env = {} as Env;

/**
 * Fake drizzle db for the single-project UPDATE path:
 *   db.update(table).set(values).where(condition)
 * `set` captures the persisted payload; `where` resolves (or throws to
 * simulate a unique-constraint collision / unexpected db error).
 */
function makeUpdateDb(opts: { whereError?: Error } = {}) {
  const setSpy = vi.fn();
  const whereSpy = vi.fn(async () => {
    if (opts.whereError) {
      throw opts.whereError;
    }
  });
  const db = {
    update: vi.fn(() => ({
      set: (values: unknown) => {
        setSpy(values);
        return { where: whereSpy };
      },
    })),
  } as never;
  return { db, setSpy, whereSpy };
}

/**
 * Fake drizzle db for the bulk path. The bulk function issues:
 *   - db.select(...).from(projects).where(...)            -> awaited directly
 *   - db.select(...).from(githubInstallations).where(...).limit(1)
 *   - db.update(projects).set(...).where(...)             -> per heal
 * Installation lookups are answered from a queue in query order (the bulk
 * function caches by installationId, so each unique id is queried once in
 * order of first appearance).
 */
function makeBulkDb(opts: {
  projects: unknown[];
  installRows: unknown[][];
  /**
   * Optional queue of per-UPDATE errors, consumed in heal order. `null` (or a
   * missing entry) means that heal succeeds; an `Error` is thrown from `where`
   * to simulate a unique-constraint collision or unexpected db error.
   */
  updateErrors?: (Error | null)[];
}) {
  const installQueue = [...opts.installRows];
  const updateErrorQueue = [...(opts.updateErrors ?? [])];
  const updatedSets: unknown[] = [];
  const db = {
    select: () => {
      let table: unknown;
      const builder = {
        from: (t: unknown) => {
          table = t;
          return builder;
        },
        where: () => {
          if (table === schema.projects) {
            return { limit: () => Promise.resolve(opts.projects) };
          }
          return { limit: () => Promise.resolve(installQueue.shift() ?? []) };
        },
      };
      return builder;
    },
    update: () => ({
      set: (values: unknown) => {
        updatedSets.push(values);
        const err = updateErrorQueue.shift() ?? null;
        return {
          where: async () => {
            if (err) {
              throw err;
            }
          },
        };
      },
    }),
  } as never;
  return { db, updatedSets };
}

describe('backfillProjectGithubRepoId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('backfills the numeric id, node id, and canonical name; update is guarded by a where clause', async () => {
    mocks.getRepositoryMetadata.mockResolvedValue({
      id: 42,
      nodeId: 'R_node42',
      fullName: 'raph/sam',
    });
    const { db, setSpy, whereSpy } = makeUpdateDb();

    const result = await backfillProjectGithubRepoId(db, env, {
      projectId: 'proj-1',
      repository: 'raph/sam',
      externalInstallationId: '120081765',
    });

    // No pre-minted token on the lazy self-heal path -> minted on demand inside getRepositoryMetadata.
    expect(mocks.getRepositoryMetadata).toHaveBeenCalledWith('120081765', 'raph', 'sam', env, undefined);
    expect(result).toEqual({
      status: 'backfilled',
      githubRepoId: 42,
      githubRepoNodeId: 'R_node42',
      fullName: 'raph/sam',
    });
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepoId: 42,
        githubRepoNodeId: 'R_node42',
        repository: 'raph/sam',
      }),
    );
    // Idempotency: the heal is a conditional UPDATE (only null rows), never blanket.
    expect(whereSpy).toHaveBeenCalledTimes(1);
    expect(whereSpy.mock.calls[0][0]).toBeDefined();
  });

  it('refreshes the stored repository to the canonical full name on a rename', async () => {
    mocks.getRepositoryMetadata.mockResolvedValue({
      id: 7,
      nodeId: 'R_node7',
      fullName: 'raph/sam-renamed',
    });
    const { db, setSpy } = makeUpdateDb();

    const result = await backfillProjectGithubRepoId(db, env, {
      projectId: 'proj-1',
      repository: 'raph/sam-old',
      externalInstallationId: '120081765',
    });

    expect(result.status).toBe('backfilled');
    expect(result.fullName).toBe('raph/sam-renamed');
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'raph/sam-renamed' }),
    );
  });

  it('skips (skipped_no_repo) without an update when the repository is inaccessible', async () => {
    mocks.getRepositoryMetadata.mockResolvedValue(null);
    const { db, setSpy } = makeUpdateDb();

    const result = await backfillProjectGithubRepoId(db, env, {
      projectId: 'proj-1',
      repository: 'raph/sam',
      externalInstallationId: '120081765',
    });

    expect(result).toEqual({
      status: 'skipped_no_repo',
      githubRepoId: null,
      githubRepoNodeId: null,
      fullName: null,
    });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('skips (skipped_no_repo) for an unparseable repository without calling GitHub', async () => {
    const { db, setSpy } = makeUpdateDb();

    const result = await backfillProjectGithubRepoId(db, env, {
      projectId: 'proj-1',
      repository: 'no-slash-here',
      externalInstallationId: '120081765',
    });

    expect(result.status).toBe('skipped_no_repo');
    expect(mocks.getRepositoryMetadata).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('returns skipped_collision WITH the numeric id (no throw) on a unique-constraint conflict', async () => {
    mocks.getRepositoryMetadata.mockResolvedValue({
      id: 99,
      nodeId: 'R_node99',
      fullName: 'raph/sam',
    });
    const { db } = makeUpdateDb({
      // Real D1 collision message format (no SQLITE_CONSTRAINT prefix in production).
      whereError: new Error('UNIQUE constraint failed: projects.user_id, github_repo_id'),
    });

    const result = await backfillProjectGithubRepoId(db, env, {
      projectId: 'proj-1',
      repository: 'raph/sam',
      externalInstallationId: '120081765',
    });

    expect(result).toEqual({
      status: 'skipped_collision',
      githubRepoId: 99,
      githubRepoNodeId: 'R_node99',
      fullName: 'raph/sam',
    });
  });

  it('returns fetch_failed when the GitHub metadata lookup throws', async () => {
    mocks.getRepositoryMetadata.mockRejectedValue(new Error('rate limited'));
    const { db, setSpy } = makeUpdateDb();

    const result = await backfillProjectGithubRepoId(db, env, {
      projectId: 'proj-1',
      repository: 'raph/sam',
      externalInstallationId: '120081765',
    });

    expect(result.status).toBe('fetch_failed');
    expect(result.githubRepoId).toBeNull();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('rethrows unexpected (non-constraint) database errors', async () => {
    mocks.getRepositoryMetadata.mockResolvedValue({
      id: 1,
      nodeId: null,
      fullName: 'raph/sam',
    });
    const { db } = makeUpdateDb({ whereError: new Error('D1_ERROR: disk I/O error') });

    await expect(
      backfillProjectGithubRepoId(db, env, {
        projectId: 'proj-1',
        repository: 'raph/sam',
        externalInstallationId: '120081765',
      }),
    ).rejects.toThrow(/disk I\/O error/);
  });
});

describe('bulkBackfillGithubRepoIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: every installation mints a token. Tests that exercise mint
    // failure override this per case.
    mocks.getInstallationToken.mockResolvedValue({
      token: 'inst-token',
      expiresAt: '2026-06-07T00:00:00.000Z',
    });
  });

  it('processes every dormant project, tallies a summary, and a single inaccessible repo does not abort the batch', async () => {
    // Two installations; the middle repo is inaccessible (null metadata).
    mocks.getRepositoryMetadata.mockImplementation(async (_inst: string, _owner: string, repo: string) => {
      if (repo === 'gone') {
        return null;
      }
      return { id: repo === 'one' ? 1 : 3, nodeId: `R_${repo}`, fullName: `org/${repo}` };
    });

    const { db, updatedSets } = makeBulkDb({
      projects: [
        { projectId: 'p1', repository: 'org/one', installationId: 'inst-a' },
        { projectId: 'p2', repository: 'org/gone', installationId: 'inst-a' },
        { projectId: 'p3', repository: 'org/three', installationId: 'inst-b' },
      ],
      installRows: [
        [{ externalInstallationId: 'ext-a' }], // first lookup: inst-a
        [{ externalInstallationId: 'ext-b' }], // second lookup: inst-b
      ],
    });

    const summary = await bulkBackfillGithubRepoIds(db, env);

    expect(summary).toEqual({
      total: 3,
      backfilled: 2,
      skippedNoRepo: 1,
      skippedCollision: 0,
      fetchFailed: 0,
      noInstallation: 0,
      hasMore: false,
    });
    // Both reachable projects were healed; the inaccessible one was skipped, not fatal.
    expect(updatedSets).toHaveLength(2);
    // inst-a was cached: one token mint + repo lookups reuse it; two installations.
    expect(mocks.getInstallationToken).toHaveBeenCalledTimes(2);
    expect(mocks.getRepositoryMetadata).toHaveBeenCalledWith('ext-a', 'org', 'one', env, 'inst-token');
    expect(mocks.getRepositoryMetadata).toHaveBeenCalledWith('ext-a', 'org', 'gone', env, 'inst-token');
    expect(mocks.getRepositoryMetadata).toHaveBeenCalledWith('ext-b', 'org', 'three', env, 'inst-token');
  });

  it('counts projects with no installation (or an installation missing an external id) as noInstallation', async () => {
    const { db, updatedSets } = makeBulkDb({
      projects: [
        { projectId: 'p1', repository: 'org/one', installationId: null },
        { projectId: 'p2', repository: 'org/two', installationId: 'inst-missing' },
      ],
      installRows: [
        [], // inst-missing resolves to no row
      ],
    });

    const summary = await bulkBackfillGithubRepoIds(db, env);

    expect(summary.total).toBe(2);
    expect(summary.noInstallation).toBe(2);
    expect(summary.backfilled).toBe(0);
    expect(summary.hasMore).toBe(false);
    expect(updatedSets).toHaveLength(0);
    expect(mocks.getRepositoryMetadata).not.toHaveBeenCalled();
    // No external installation resolved, so no token is minted.
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it('is idempotent: with no dormant projects remaining it does nothing', async () => {
    const { db, updatedSets } = makeBulkDb({ projects: [], installRows: [] });

    const summary = await bulkBackfillGithubRepoIds(db, env);

    expect(summary).toEqual({
      total: 0,
      backfilled: 0,
      skippedNoRepo: 0,
      skippedCollision: 0,
      fetchFailed: 0,
      noInstallation: 0,
      hasMore: false,
    });
    expect(updatedSets).toHaveLength(0);
    expect(mocks.getRepositoryMetadata).not.toHaveBeenCalled();
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it('tallies skipped_collision and fetch_failed without aborting, and reuses one token per installation', async () => {
    // p1 heals; p2 hits a unique collision on UPDATE; p3 fetch throws.
    mocks.getRepositoryMetadata.mockImplementation(
      async (_inst: string, _owner: string, repo: string) => {
        if (repo === 'boom') {
          throw new Error('GitHub 502');
        }
        return { id: repo === 'one' ? 1 : 2, nodeId: `R_${repo}`, fullName: `org/${repo}` };
      },
    );

    const { db, updatedSets } = makeBulkDb({
      projects: [
        { projectId: 'p1', repository: 'org/one', installationId: 'inst-a' },
        { projectId: 'p2', repository: 'org/two', installationId: 'inst-a' },
        { projectId: 'p3', repository: 'org/boom', installationId: 'inst-a' },
      ],
      installRows: [[{ externalInstallationId: 'ext-a' }]],
      // First heal (p1) succeeds; second heal (p2) collides.
      updateErrors: [null, new Error('UNIQUE constraint failed: projects.user_id, github_repo_id')],
    });

    const summary = await bulkBackfillGithubRepoIds(db, env);

    expect(summary).toEqual({
      total: 3,
      backfilled: 1,
      skippedNoRepo: 0,
      skippedCollision: 1,
      fetchFailed: 1,
      noInstallation: 0,
      hasMore: false,
    });
    // p1 + p2 both attempted an UPDATE (p3 failed before persistence).
    expect(updatedSets).toHaveLength(2);
    // One installation -> exactly one token mint, reused across all three repos.
    expect(mocks.getInstallationToken).toHaveBeenCalledTimes(1);
  });

  it('counts every project under an installation whose token cannot be minted as fetch_failed (no repo lookup)', async () => {
    mocks.getInstallationToken.mockRejectedValue(new Error('token mint rate limited'));

    const { db, updatedSets } = makeBulkDb({
      projects: [
        { projectId: 'p1', repository: 'org/one', installationId: 'inst-a' },
        { projectId: 'p2', repository: 'org/two', installationId: 'inst-a' },
      ],
      installRows: [[{ externalInstallationId: 'ext-a' }]],
    });

    const summary = await bulkBackfillGithubRepoIds(db, env);

    expect(summary.fetchFailed).toBe(2);
    expect(summary.backfilled).toBe(0);
    expect(updatedSets).toHaveLength(0);
    // Mint failure is cached: only one mint attempt for the shared installation.
    expect(mocks.getInstallationToken).toHaveBeenCalledTimes(1);
    // No token -> never reach the repo metadata fetch.
    expect(mocks.getRepositoryMetadata).not.toHaveBeenCalled();
  });

  it('caps a batch at the limit and reports hasMore when the batch fills', async () => {
    mocks.getRepositoryMetadata.mockResolvedValue({ id: 1, nodeId: 'R_1', fullName: 'org/one' });

    const { db } = makeBulkDb({
      projects: [
        { projectId: 'p1', repository: 'org/one', installationId: 'inst-a' },
        { projectId: 'p2', repository: 'org/two', installationId: 'inst-a' },
      ],
      installRows: [[{ externalInstallationId: 'ext-a' }]],
    });

    const summary = await bulkBackfillGithubRepoIds(db, env, { limit: 2 });

    // The batch filled to the requested limit, so more dormant projects may remain.
    expect(summary.total).toBe(2);
    expect(summary.hasMore).toBe(true);
  });
});
