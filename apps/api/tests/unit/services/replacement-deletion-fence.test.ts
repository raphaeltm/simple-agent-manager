import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  assertReplacementDeletionConfirmed,
  WorkspaceDeletionUnconfirmedError,
} from '../../../src/services/replacement-deletion-fence';

function buildEnv(row: Record<string, unknown> | null): Env {
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { DATABASE: { prepare } as unknown as D1Database } as Env;
}

const input = {
  sourceTaskId: 'task-old',
  projectId: 'project-1',
  userId: 'user-1',
};

describe('replacement deletion fence', () => {
  it('fences a linked replacement while deletion is unconfirmed', async () => {
    const env = buildEnv({
      workspaceId: 'workspace-old',
      workspaceStatus: 'stopping',
      workspaceErrorMessage: 'Workspace deletion unconfirmed: VM attempt 1',
      runtimeTerminationConfirmedAt: null,
    });

    await expect(assertReplacementDeletionConfirmed(env, input)).rejects.toBeInstanceOf(
      WorkspaceDeletionUnconfirmedError
    );
  });

  it('observes the durable pre-network claim even before another D1 reader sees stopping', async () => {
    const env = buildEnv({
      workspaceId: 'workspace-old',
      workspaceStatus: 'stopped',
      workspaceErrorMessage: null,
      nodeId: 'node-old',
      runtimeTerminationConfirmedAt: null,
    });
    env.NODE_LIFECYCLE = {
      idFromName: vi.fn(() => 'node-lifecycle-id'),
      get: vi.fn(() => ({
        getWorkspaceDeletionAttemptState: vi.fn(async () => ({
          pending: true,
          attemptStarted: true,
        })),
      })),
    } as unknown as DurableObjectNamespace;

    await expect(assertReplacementDeletionConfirmed(env, input)).rejects.toBeInstanceOf(
      WorkspaceDeletionUnconfirmedError
    );
  });

  it('releases the fence after strict provider/container termination proof', async () => {
    const env = buildEnv({
      workspaceId: 'workspace-old',
      workspaceStatus: 'stopping',
      workspaceErrorMessage: 'Workspace deletion unconfirmed: VM attempt 1',
      runtimeTerminationConfirmedAt: '2026-09-04T00:00:00.000Z',
    });

    await expect(assertReplacementDeletionConfirmed(env, input)).resolves.toBeUndefined();
  });

  it('does not fence ordinary sleeping recovery before a deletion attempt', async () => {
    const env = buildEnv({
      workspaceId: 'workspace-old',
      workspaceStatus: 'sleeping',
      workspaceErrorMessage: null,
      runtimeTerminationConfirmedAt: null,
    });

    await expect(assertReplacementDeletionConfirmed(env, input)).resolves.toBeUndefined();
  });

  it('allows a predecessor whose workspace is already finalized or absent', async () => {
    await expect(
      assertReplacementDeletionConfirmed(buildEnv(null), input)
    ).resolves.toBeUndefined();
    await expect(
      assertReplacementDeletionConfirmed(
        buildEnv({
          workspaceId: 'workspace-old',
          workspaceStatus: 'deleted',
          workspaceErrorMessage: null,
          runtimeTerminationConfirmedAt: null,
        }),
        input
      )
    ).resolves.toBeUndefined();
  });
});
