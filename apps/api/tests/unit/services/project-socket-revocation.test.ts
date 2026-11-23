/**
 * Failure branches of the socket close that follows a project-access revocation. The close runs
 * after the revocation is committed, so a failed close must be visible: it is logged, and
 * suspension answers a retryable 503 after trying every project.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const closeBrowserSocketsForActor = vi.fn();
vi.mock('../../../src/services/project-data', () => ({ closeBrowserSocketsForActor }));

const { closeSuspendedUserSockets } =
  await import('../../../src/services/project-socket-revocation');

const SUSPENDED_AT = new Date('2026-11-23T12:00:00.000Z');

/** A D1 stub that answers the paged membership query from a sorted list, like the real seek. */
function envWithMemberships(projectIds: string[], opts: { failRead?: boolean } = {}): Env {
  const sorted = [...projectIds].sort();
  return {
    DATABASE: {
      prepare: () => ({
        bind: (userId: string, _since: string, after: string, limit: number) => ({
          all: async () => {
            if (opts.failRead) throw new Error('D1 unavailable');
            expect(userId).toBe('user-1');
            const page = sorted.filter((id) => id > after).slice(0, limit);
            return { results: page.map((project_id) => ({ project_id })) };
          },
        }),
      }),
    },
  } as unknown as Env;
}

describe('project socket revocation', () => {
  beforeEach(() => closeBrowserSocketsForActor.mockReset());

  it('closes on every project, then answers 503 when any close failed', async () => {
    closeBrowserSocketsForActor.mockImplementation(async (_env, projectId: string) => {
      if (projectId === 'project-b') throw new Error('object unavailable');
      return 1;
    });

    await expect(
      closeSuspendedUserSockets(
        envWithMemberships(['project-a', 'project-b', 'project-c']),
        'user-1',
        SUSPENDED_AT
      )
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(closeBrowserSocketsForActor.mock.calls.map((call) => call[1])).toEqual([
      'project-a',
      'project-b',
      'project-c',
    ]);
  });

  it('control: succeeds when every close succeeds', async () => {
    closeBrowserSocketsForActor.mockResolvedValue(1);

    await expect(
      closeSuspendedUserSockets(
        envWithMemberships(['project-a', 'project-b']),
        'user-1',
        SUSPENDED_AT
      )
    ).resolves.toBeUndefined();
    expect(closeBrowserSocketsForActor).toHaveBeenCalledTimes(2);
  });

  it('closes on every page of memberships, past the page size', async () => {
    closeBrowserSocketsForActor.mockResolvedValue(0);
    const projects = Array.from({ length: 205 }, (_, i) => `project-${String(i).padStart(3, '0')}`);

    await closeSuspendedUserSockets(envWithMemberships(projects), 'user-1', SUSPENDED_AT);

    const closed = closeBrowserSocketsForActor.mock.calls.map((call) => call[1]);
    expect(closed).toHaveLength(205);
    expect(new Set(closed)).toEqual(new Set(projects));
  });

  it('answers 503 when the membership read fails, without closing anything', async () => {
    await expect(
      closeSuspendedUserSockets(
        envWithMemberships(['project-a'], { failRead: true }),
        'user-1',
        SUSPENDED_AT
      )
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(closeBrowserSocketsForActor).not.toHaveBeenCalled();
  });

  describe('against real SQL', () => {
    type Row = [project: string, status: string, removedAt?: string];
    function membershipDb(rows: Row[]) {
      const sqlite = new Database(':memory:');
      createAllSchemaTables(sqlite, schema);
      const insert = sqlite.prepare(
        `INSERT INTO project_members (project_id, user_id, role, status, removed_at, created_at, updated_at)
         VALUES (?, ?, 'member', ?, ?, '2026-11-01', '2026-11-01')`
      );
      for (const [project, status, removedAt] of rows)
        insert.run(project, 'user-1', status, removedAt ?? null);
      insert.run('project-other-user', 'user-2', 'active', null);
      return { sqlite, env: { DATABASE: createSqliteD1(sqlite) } as unknown as Env };
    }
    const closed = () => closeBrowserSocketsForActor.mock.calls.map((call) => call[1]);

    it('a retry still closes a project whose membership was removed after a failed close', async () => {
      const { sqlite, env } = membershipDb([
        ['project-a', 'active'],
        ['project-b', 'active'],
      ]);
      closeBrowserSocketsForActor.mockImplementation(async (_env, projectId: string) => {
        if (projectId === 'project-b') throw new Error('object unavailable');
        return 1;
      });
      await expect(closeSuspendedUserSockets(env, 'user-1', SUSPENDED_AT)).rejects.toMatchObject({
        statusCode: 503,
      });

      // Offboarding removes the member from project-b before the admin retries; its own close
      // failed too, so the socket on project-b is still open.
      sqlite
        .prepare(
          `UPDATE project_members SET status = 'removed', removed_at = '2026-11-23T12:05:00.000Z'
           WHERE project_id = 'project-b'`
        )
        .run();
      closeBrowserSocketsForActor.mockReset();
      closeBrowserSocketsForActor.mockResolvedValue(1);

      // The retry keeps the original suspension start.
      await expect(closeSuspendedUserSockets(env, 'user-1', SUSPENDED_AT)).resolves.toBeUndefined();
      expect(closed()).toEqual(['project-a', 'project-b']);
      expect(closeBrowserSocketsForActor.mock.calls.every((call) => call[2] === 'user-1')).toBe(
        true
      );
      sqlite.close();
    });

    it('targets active and since-suspension removals only, never another user', async () => {
      const { sqlite, env } = membershipDb([
        ['project-active', 'active'],
        ['project-removed-after', 'removed', '2026-11-23T12:00:00.000Z'],
        ['project-removed-before', 'removed', '2026-11-20T09:00:00.000Z'],
        ['project-invited', 'invited'],
        ['project-member-suspended', 'suspended'],
      ]);
      closeBrowserSocketsForActor.mockResolvedValue(0);

      await closeSuspendedUserSockets(env, 'user-1', SUSPENDED_AT);

      expect(closed()).toEqual(['project-active', 'project-removed-after']);
      sqlite.close();
    });

    it('pages past the page size', async () => {
      const rows = Array.from({ length: 205 }, (_, i): Row =>
        i % 2 === 0
          ? [`project-${String(i).padStart(3, '0')}`, 'active']
          : [`project-${String(i).padStart(3, '0')}`, 'removed', '2026-11-23T13:00:00.000Z']
      );
      const { sqlite, env } = membershipDb(rows);
      closeBrowserSocketsForActor.mockResolvedValue(0);

      await closeSuspendedUserSockets(env, 'user-1', SUSPENDED_AT);

      expect(closed()).toHaveLength(205);
      expect(new Set(closed())).toEqual(new Set(rows.map(([project]) => project)));
      sqlite.close();
    });
  });
});
