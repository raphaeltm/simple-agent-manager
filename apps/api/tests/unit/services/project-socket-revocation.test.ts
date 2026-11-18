/**
 * Failure branches of the socket close that follows a project-access revocation. The close runs
 * after the revocation is committed, so a failed close must be visible: it is logged, and
 * suspension answers a retryable 503 after trying every project.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const closeBrowserSocketsForActor = vi.fn();
vi.mock('../../../src/services/project-data', () => ({ closeBrowserSocketsForActor }));

const { closeSuspendedUserSockets } =
  await import('../../../src/services/project-socket-revocation');

/** A D1 stub that answers the paged membership query from a sorted list, like the real seek. */
function envWithMemberships(projectIds: string[], opts: { failRead?: boolean } = {}): Env {
  const sorted = [...projectIds].sort();
  return {
    DATABASE: {
      prepare: (sql: string) => ({
        bind: (userId: string, after: string, limit: number) => ({
          all: async () => {
            if (opts.failRead) throw new Error('D1 unavailable');
            expect(sql).toContain("status = 'active'");
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
});
