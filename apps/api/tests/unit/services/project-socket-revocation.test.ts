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

/** A D1 stub that answers the paged membership query from a sorted list, like the real seek. */
function envWithMemberships(projectIds: string[], opts: { failRead?: boolean } = {}): Env {
  const sorted = [...projectIds].sort();
  return {
    DATABASE: {
      prepare: () => ({
        bind: (userId: string, after: string, limit: number) => ({
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
        'user-1'
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
      closeSuspendedUserSockets(envWithMemberships(['project-a', 'project-b']), 'user-1')
    ).resolves.toBeUndefined();
    expect(closeBrowserSocketsForActor).toHaveBeenCalledTimes(2);
  });

  it('closes on every page of memberships, past the page size', async () => {
    closeBrowserSocketsForActor.mockResolvedValue(0);
    const projects = Array.from({ length: 205 }, (_, i) => `project-${String(i).padStart(3, '0')}`);

    await closeSuspendedUserSockets(envWithMemberships(projects), 'user-1');

    const closed = closeBrowserSocketsForActor.mock.calls.map((call) => call[1]);
    expect(closed).toHaveLength(205);
    expect(new Set(closed)).toEqual(new Set(projects));
  });

  it('answers 503 when the membership read fails, without closing anything', async () => {
    await expect(
      closeSuspendedUserSockets(envWithMemberships(['project-a'], { failRead: true }), 'user-1')
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(closeBrowserSocketsForActor).not.toHaveBeenCalled();
  });

  describe('against real SQL', () => {
    function membershipDb(rows: Array<[project: string, status: string]>) {
      const sqlite = new Database(':memory:');
      createAllSchemaTables(sqlite, schema);
      const insert = sqlite.prepare(
        `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, 'member', ?, '2026-11-23', '2026-11-23')`
      );
      for (const [project, status] of rows) insert.run(project, 'user-1', status);
      insert.run('project-other-user', 'user-2', 'active');
      return { sqlite, env: { DATABASE: createSqliteD1(sqlite) } as unknown as Env };
    }

    it('a retry still closes a project whose membership was removed after a failed close', async () => {
      const { sqlite, env } = membershipDb([
        ['project-a', 'active'],
        ['project-b', 'active'],
      ]);
      closeBrowserSocketsForActor.mockImplementation(async (_env, projectId: string) => {
        if (projectId === 'project-b') throw new Error('object unavailable');
        return 1;
      });
      await expect(closeSuspendedUserSockets(env, 'user-1')).rejects.toMatchObject({
        statusCode: 503,
      });

      // Offboarding removes the member from project-b before the admin retries; its own close
      // failed too, so the socket on project-b is still open.
      sqlite
        .prepare(`UPDATE project_members SET status = 'removed' WHERE project_id = 'project-b'`)
        .run();
      closeBrowserSocketsForActor.mockReset();
      closeBrowserSocketsForActor.mockResolvedValue(1);

      await expect(closeSuspendedUserSockets(env, 'user-1')).resolves.toBeUndefined();
      const retried = closeBrowserSocketsForActor.mock.calls.map((call) => call[1]);
      expect(retried).toContain('project-b');
      expect(retried).toContain('project-a');
      // Scoped to the suspended user's own memberships.
      expect(retried).not.toContain('project-other-user');
      expect(closeBrowserSocketsForActor.mock.calls.every((call) => call[2] === 'user-1')).toBe(
        true
      );
      sqlite.close();
    });

    it('pages through every membership status past the page size', async () => {
      const statuses = ['active', 'removed', 'suspended', 'invited'];
      const rows = Array.from(
        { length: 205 },
        (_, i) => [`project-${String(i).padStart(3, '0')}`, statuses[i % 4]!] as [string, string]
      );
      const { sqlite, env } = membershipDb(rows);
      closeBrowserSocketsForActor.mockResolvedValue(0);

      await closeSuspendedUserSockets(env, 'user-1');

      const closed = closeBrowserSocketsForActor.mock.calls.map((call) => call[1]);
      expect(closed).toHaveLength(205);
      expect(new Set(closed)).toEqual(new Set(rows.map(([project]) => project)));
      sqlite.close();
    });
  });
});
