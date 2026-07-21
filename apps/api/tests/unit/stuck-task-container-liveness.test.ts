import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { getTaskRuntimeLiveness } from '../../src/scheduled/stuck-tasks';

function createEnv(input: {
  status: 'running' | 'sleeping' | 'recovering' | 'error';
  activeWorkStatus?: 'active' | 'ended' | 'expired' | null;
  rejectProbe?: boolean;
}): Env {
  const inspectLifecycle = input.rejectProbe
    ? vi.fn().mockRejectedValue(new Error('DO unavailable'))
    : vi.fn().mockResolvedValue({
        status: input.status,
        recoveryPhase: input.status === 'recovering' ? 'waking' : null,
        recoveryTrigger: input.status === 'recovering' ? 'stop' : null,
        activeWorkStatus: input.activeWorkStatus ?? null,
      });
  return {
    CF_CONTAINER_ENABLED: 'true',
    DATABASE: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            workspace_status: 'running',
            chat_session_id: 'chat-1',
            node_id: 'node-1',
            node_status: 'running',
            health_status: 'healthy',
            last_heartbeat_at: new Date().toISOString(),
            node_runtime: 'cf-container',
          }),
        }),
      }),
    } as unknown as D1Database,
    VM_AGENT_CONTAINER: {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({ inspectLifecycle }),
    } as unknown as Env['VM_AGENT_CONTAINER'],
  } as Env;
}

const task = { project_id: 'project-1', workspace_id: 'workspace-1' };

describe('stuck-task Instant lifecycle liveness', () => {
  it('proves live active work without relying on ACP heartbeat freshness', async () => {
    await expect(
      getTaskRuntimeLiveness(createEnv({ status: 'running', activeWorkStatus: 'active' }), task)
    ).resolves.toMatchObject({
      live: true,
      conclusive: true,
      reason: 'cf_container_active_work',
    });
  });

  it.each(['sleeping', 'recovering'] as const)(
    'preserves a %s Instant lifecycle as resumable',
    async (status) => {
      await expect(getTaskRuntimeLiveness(createEnv({ status }), task)).resolves.toMatchObject({
        live: false,
        conclusive: false,
        reason: `cf_container_${status}_resumable`,
      });
    }
  );

  it('allows reconciliation after the Instant lifecycle reaches a true error', async () => {
    await expect(
      getTaskRuntimeLiveness(createEnv({ status: 'error' }), task)
    ).resolves.toMatchObject({
      live: false,
      conclusive: true,
      reason: 'cf_container_error',
    });
  });

  it('treats a failed lifecycle probe as inconclusive', async () => {
    await expect(
      getTaskRuntimeLiveness(createEnv({ status: 'running', rejectProbe: true }), task)
    ).resolves.toMatchObject({
      live: false,
      conclusive: false,
      reason: 'cf_container_lifecycle_unknown',
    });
  });
});
