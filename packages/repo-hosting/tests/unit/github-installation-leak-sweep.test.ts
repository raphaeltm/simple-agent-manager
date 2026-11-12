import { and, eq, gt } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInstallationAccount: vi.fn(),
  generateAppJWT: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({ log: mocks.log }));
vi.mock('../../../src/services/github-app', () => ({
  getInstallationAccount: mocks.getInstallationAccount,
  generateAppJWT: mocks.generateAppJWT,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { bulkSweepMismatchedPersonalInstallations } from '../../../src/services/github-installation-leak-sweep';

const env = {} as Env;

/**
 * Fake drizzle db for the sweep path. The sweep issues:
 *   - db.select(...).from(githubInstallations).where(...).orderBy(...).limit(limit)
 *       -> the batch of personal rows (awaited via .limit())
 *   - db.select(...).from(users).where(eq(id,userId)).limit(1)   (cached per userId)
 *   - db.select(...).from(projects).where(eq(installationId,id)).limit(1) (per mismatch)
 *   - db.delete(githubInstallations).where(and(...))             (per confirmed mismatch)
 * User and project lookups are answered from queues in query order; the sweep
 * caches the owning user's github_id by userId, so each unique user is queried
 * once in order of first appearance. Only mismatched rows reach the projects
 * lookup, and only mismatched + unreferenced rows reach the delete.
 */
function makeSweepDb(opts: {
  installations: unknown[];
  usersQueue: unknown[][];
  projectsQueue?: unknown[][];
  workspacesQueue?: unknown[][];
}) {
  const usersQueue = [...opts.usersQueue];
  const projectsQueue = [...(opts.projectsQueue ?? [])];
  const workspacesQueue = [...(opts.workspacesQueue ?? [])];
  const deletedConditions: unknown[] = [];
  const installationsWhere: unknown[] = [];
  const db = {
    select: () => {
      let table: unknown;
      const builder = {
        from: (t: unknown) => {
          table = t;
          return builder;
        },
        where: (cond: unknown) => {
          if (table === schema.githubInstallations) {
            installationsWhere.push(cond);
          }
          return builder;
        },
        orderBy: () => builder,
        limit: () => {
          if (table === schema.githubInstallations) {
            return Promise.resolve(opts.installations);
          }
          if (table === schema.users) {
            return Promise.resolve(usersQueue.shift() ?? []);
          }
          if (table === schema.projects) {
            return Promise.resolve(projectsQueue.shift() ?? []);
          }
          if (table === schema.workspaces) {
            return Promise.resolve(workspacesQueue.shift() ?? []);
          }
          return Promise.resolve([]);
        },
      };
      return builder;
    },
    delete: () => ({
      where: (cond: unknown) => {
        deletedConditions.push(cond);
        return Promise.resolve();
      },
    }),
  } as never;
  return { db, deletedConditions, installationsWhere };
}

function personalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    userId: 'user-1',
    installationId: 'inst-1',
    externalInstallationId: 'ext-1',
    accountName: 'octocat',
    ...overrides,
  };
}

describe('bulkSweepMismatchedPersonalInstallations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateAppJWT.mockResolvedValue('app-jwt');
  });

  it('deletes only the mismatched, unreferenced personal row — keeps the matched one and skips the project-referenced mismatch', async () => {
    // Row A: account 999 != user 111 -> mismatch, unreferenced -> DELETE.
    // Row B: account 222 == user 222 -> match -> keep (never touched).
    // Row D: account 888 != user 333 -> mismatch, project-referenced -> SKIP.
    const rowA = personalRow({ id: 'rowA', userId: 'userA', externalInstallationId: 'extA', accountName: 'a' });
    const rowB = personalRow({ id: 'rowB', userId: 'userB', externalInstallationId: 'extB', accountName: 'b' });
    const rowD = personalRow({ id: 'rowD', userId: 'userD', externalInstallationId: 'extD', accountName: 'd' });

    mocks.getInstallationAccount.mockImplementation(async (externalInstallationId: string) => {
      const byId: Record<string, { id: number; login: string; type: string }> = {
        extA: { id: 999, login: 'a', type: 'User' },
        extB: { id: 222, login: 'b', type: 'User' },
        extD: { id: 888, login: 'd', type: 'User' },
      };
      return byId[externalInstallationId] ?? null;
    });

    const { db, deletedConditions } = makeSweepDb({
      installations: [rowA, rowB, rowD],
      usersQueue: [
        [{ githubId: '111' }], // userA
        [{ githubId: '222' }], // userB (match)
        [{ githubId: '333' }], // userD
      ],
      // Only mismatched rows (A, then D) reach the projects lookup.
      projectsQueue: [
        [], // rowA: unreferenced
        [{ id: 'proj-d' }], // rowD: referenced -> skip
      ],
    });

    const summary = await bulkSweepMismatchedPersonalInstallations(db, env);

    expect(summary).toEqual({
      total: 3,
      deleted: 1,
      matched: 1,
      skippedReferenced: 1,
      noUser: 0,
      accountUnresolved: 0,
      fetchFailed: 0,
      hasMore: false,
      nextCursor: 'rowD',
    });
    // Exactly one delete fired (rowA); the matched and referenced rows were never deleted.
    expect(deletedConditions).toHaveLength(1);
    expect(mocks.log.info).toHaveBeenCalledWith(
      'github.installation_leak_sweep.deleted_mismatched_personal',
      expect.objectContaining({ installationRowId: 'rowA', userId: 'userA', accountId: '999', userGithubId: '111' }),
    );
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.installation_leak_sweep.skipped_referenced',
      expect.objectContaining({ installationRowId: 'rowD', userId: 'userD', accountId: '888', userGithubId: '333' }),
    );
  });

  it('counts a row whose owning user is missing (or has no github_id) as noUser and never resolves its account', async () => {
    const { db, deletedConditions } = makeSweepDb({
      installations: [personalRow()],
      usersQueue: [[]], // no user row
    });

    const summary = await bulkSweepMismatchedPersonalInstallations(db, env);

    expect(summary.total).toBe(1);
    expect(summary.noUser).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(deletedConditions).toHaveLength(0);
    // Cannot compare identity without the user's github_id -> never hit the GitHub API.
    expect(mocks.getInstallationAccount).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.installation_leak_sweep.no_user_github_id',
      expect.objectContaining({ installationRowId: 'row-1', userId: 'user-1' }),
    );
  });

  it('counts a row whose account fetch throws as fetchFailed without deleting it (a re-run retries it)', async () => {
    mocks.getInstallationAccount.mockRejectedValue(new Error('GitHub 502'));

    const { db, deletedConditions } = makeSweepDb({
      installations: [personalRow()],
      usersQueue: [[{ githubId: '111' }]],
    });

    const summary = await bulkSweepMismatchedPersonalInstallations(db, env);

    expect(summary.fetchFailed).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(deletedConditions).toHaveLength(0);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.installation_leak_sweep.account_fetch_failed',
      expect.objectContaining({ installationRowId: 'row-1' }),
    );
  });

  it('counts a row whose account cannot be resolved (null / no numeric id) as accountUnresolved without deleting it', async () => {
    mocks.getInstallationAccount.mockResolvedValue(null);

    const { db, deletedConditions } = makeSweepDb({
      installations: [personalRow()],
      usersQueue: [[{ githubId: '111' }]],
    });

    const summary = await bulkSweepMismatchedPersonalInstallations(db, env);

    expect(summary.accountUnresolved).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(deletedConditions).toHaveLength(0);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.installation_leak_sweep.account_unresolved',
      expect.objectContaining({ installationRowId: 'row-1' }),
    );
  });

  it('reports hasMore and the trailing cursor when the batch fills to the limit', async () => {
    // Both rows match their owner -> kept; the batch still fills the limit.
    mocks.getInstallationAccount.mockImplementation(async (externalInstallationId: string) => {
      const byId: Record<string, { id: number; login: string; type: string }> = {
        extX: { id: 1, login: 'x', type: 'User' },
        extY: { id: 2, login: 'y', type: 'User' },
      };
      return byId[externalInstallationId] ?? null;
    });

    const { db } = makeSweepDb({
      installations: [
        personalRow({ id: 'rowX', userId: 'userX', externalInstallationId: 'extX' }),
        personalRow({ id: 'rowY', userId: 'userY', externalInstallationId: 'extY' }),
      ],
      usersQueue: [[{ githubId: '1' }], [{ githubId: '2' }]],
    });

    const summary = await bulkSweepMismatchedPersonalInstallations(db, env, { limit: 2 });

    expect(summary.total).toBe(2);
    expect(summary.matched).toBe(2);
    expect(summary.deleted).toBe(0);
    // Batch filled to the requested limit -> more personal rows may remain.
    expect(summary.hasMore).toBe(true);
    expect(summary.nextCursor).toBe('rowY');
  });

  it('only ever queries personal rows — org installations are excluded by the SQL filter, so they are never fetched or deleted', async () => {
    // The sweep never re-checks account_type in code; org rows are kept safe purely
    // by the `account_type = 'personal'` WHERE filter on the batch query. This asserts
    // that filter is actually applied so a future refactor cannot silently start
    // sweeping (and deleting) organization installation rows.
    const { db, installationsWhere } = makeSweepDb({ installations: [], usersQueue: [] });

    await bulkSweepMismatchedPersonalInstallations(db, env);

    expect(installationsWhere).toHaveLength(1);
    expect(installationsWhere[0]).toEqual(
      eq(schema.githubInstallations.accountType, 'personal')
    );
  });

  it('skips a mismatched row referenced only by a workspace (dangling-FK guard) without deleting it', async () => {
    // workspaces.installation_id references github_installations.id with NO ON DELETE
    // action, and SQLite FK enforcement is off in migrations — deleting the row would
    // leave the workspace with a dangling installation_id. The guard must skip it even
    // when no project references it.
    mocks.getInstallationAccount.mockResolvedValue({ id: 999, login: 'a', type: 'User' });

    const { db, deletedConditions } = makeSweepDb({
      installations: [personalRow()],
      usersQueue: [[{ githubId: '111' }]], // 111 != account 999 -> mismatch
      projectsQueue: [[]], // not project-referenced
      workspacesQueue: [[{ id: 'ws-1' }]], // but a workspace still references it
    });

    const summary = await bulkSweepMismatchedPersonalInstallations(db, env);

    expect(summary.skippedReferenced).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(deletedConditions).toHaveLength(0);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.installation_leak_sweep.skipped_referenced',
      expect.objectContaining({ installationRowId: 'row-1', referencedBy: 'workspace' }),
    );
  });

  it('continues from afterId with the personal filter still intact (composite cursor WHERE)', async () => {
    // A re-run passes afterId = previous nextCursor. The batch query must combine the
    // cursor with the account_type='personal' filter so pagination cannot silently
    // start scanning org rows.
    const { db, installationsWhere } = makeSweepDb({ installations: [], usersQueue: [] });

    await bulkSweepMismatchedPersonalInstallations(db, env, { afterId: 'cursor-x' });

    expect(installationsWhere).toHaveLength(1);
    expect(installationsWhere[0]).toEqual(
      and(
        eq(schema.githubInstallations.accountType, 'personal'),
        gt(schema.githubInstallations.id, 'cursor-x')
      )
    );
  });

  it('is a no-op with an empty summary when no personal rows remain', async () => {
    const { db, deletedConditions } = makeSweepDb({ installations: [], usersQueue: [] });

    const summary = await bulkSweepMismatchedPersonalInstallations(db, env);

    expect(summary).toEqual({
      total: 0,
      deleted: 0,
      matched: 0,
      skippedReferenced: 0,
      noUser: 0,
      accountUnresolved: 0,
      fetchFailed: 0,
      hasMore: false,
      nextCursor: null,
    });
    expect(deletedConditions).toHaveLength(0);
    expect(mocks.getInstallationAccount).not.toHaveBeenCalled();
  });
});
