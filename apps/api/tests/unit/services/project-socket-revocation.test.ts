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

function envWithMemberships(projectIds: string[]): Env {
  const bound: unknown[] = [];
  return {
    DATABASE: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          bound.push(...values);
          return {
            all: async () => {
              expect(sql).toContain("status = 'active'");
              expect(bound).toEqual(['user-1']);
              return { results: projectIds.map((project_id) => ({ project_id })) };
            },
          };
        },
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
});
