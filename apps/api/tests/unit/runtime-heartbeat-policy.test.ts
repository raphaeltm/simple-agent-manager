import { describe, expect, it, vi } from 'vitest';

import { shouldDeferRuntimeHeartbeatTimeout } from '../../src/durable-objects/project-data/runtime-heartbeat-policy';
import type { Env } from '../../src/durable-objects/project-data/types';
import type { VmAgentContainerLifecycleStatus } from '../../src/durable-objects/vm-agent-container-lifecycle';

function createEnv(input: {
  runtime?: string;
  workspaceStatus?: string;
  lifecycleStatus?: VmAgentContainerLifecycleStatus | null;
  binding?: boolean;
  pendingProbe?: boolean;
}): Env {
  const first = vi.fn().mockResolvedValue({
    workspace_status: input.workspaceStatus ?? 'sleeping',
    node_runtime: input.runtime ?? 'cf-container',
  });
  const inspectLifecycle = input.pendingProbe
    ? vi.fn().mockReturnValue(new Promise(() => undefined))
    : vi.fn().mockResolvedValue({
        status: input.lifecycleStatus ?? 'sleeping',
        recoveryPhase: null,
        recoveryTrigger: null,
        activeWorkStatus: null,
      });
  return {
    DATABASE: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ first }),
      }),
    } as unknown as D1Database,
    VM_AGENT_CONTAINER:
      input.binding === false
        ? undefined
        : ({
            idFromName: vi.fn().mockReturnValue('do-id'),
            get: vi.fn().mockReturnValue({ inspectLifecycle }),
          } as unknown as Env['VM_AGENT_CONTAINER']),
  };
}

const candidate = { workspaceId: 'ws-1', nodeId: 'node-1' };

describe('ProjectData runtime heartbeat timeout policy', () => {
  it.each(['sleeping', 'recovering', 'waking', 'restoring', 'running'] as const)(
    'defers timeout while the Instant lifecycle is %s',
    async (lifecycleStatus) => {
      await expect(
        shouldDeferRuntimeHeartbeatTimeout(createEnv({ lifecycleStatus }), candidate)
      ).resolves.toMatchObject({ defer: true, reason: `cf_container_${lifecycleStatus}` });
    }
  );

  it('defers conservatively when the container binding is unavailable', async () => {
    await expect(
      shouldDeferRuntimeHeartbeatTimeout(createEnv({ binding: false }), candidate)
    ).resolves.toEqual({
      defer: true,
      reason: 'cf_container_lifecycle_binding_unavailable',
    });
  });

  it('bounds a lifecycle probe that never settles', async () => {
    await expect(
      shouldDeferRuntimeHeartbeatTimeout(
        { ...createEnv({ pendingProbe: true }), TASK_LIVENESS_PROBE_TIMEOUT_MS: '1' },
        candidate
      )
    ).resolves.toEqual({ defer: true, reason: 'cf_container_lifecycle_timeout' });
  });

  it.each(['stopping', 'stopped', 'expired', 'error'] as const)(
    'allows timeout after the Instant lifecycle is %s',
    async (lifecycleStatus) => {
      await expect(
        shouldDeferRuntimeHeartbeatTimeout(createEnv({ lifecycleStatus }), candidate)
      ).resolves.toMatchObject({ defer: false, reason: `cf_container_${lifecycleStatus}` });
    }
  );

  it('keeps VM/devcontainer heartbeat timeout behavior unchanged', async () => {
    await expect(
      shouldDeferRuntimeHeartbeatTimeout(createEnv({ runtime: 'vm' }), candidate)
    ).resolves.toEqual({ defer: false, reason: 'non_container_runtime' });
  });

  it.each(['stopping', 'stopped'])(
    'does not defer after an explicit %s workspace transition',
    async (workspaceStatus) => {
      await expect(
        shouldDeferRuntimeHeartbeatTimeout(
          createEnv({ workspaceStatus, lifecycleStatus: 'sleeping' }),
          candidate
        )
      ).resolves.toEqual({ defer: false, reason: `workspace_${workspaceStatus}` });
    }
  );
});
