import { describe, expect, it } from 'vitest';

import {
  classifyVmAgentContainerLiveness,
  type VmAgentContainerLifecycleInspection,
  type VmAgentContainerLifecycleStatus,
} from '../../src/durable-objects/vm-agent-container-lifecycle';

function inspection(
  status: VmAgentContainerLifecycleStatus | null,
  activeWorkStatus: VmAgentContainerLifecycleInspection['activeWorkStatus'] = null
): VmAgentContainerLifecycleInspection {
  return { status, activeWorkStatus, recoveryPhase: null, recoveryTrigger: null };
}

describe('VM agent container lifecycle liveness', () => {
  it('proves task-scoped liveness only while active work is registered', () => {
    expect(classifyVmAgentContainerLiveness(inspection('running', 'active'))).toEqual({
      live: true,
      conclusive: true,
      reason: 'cf_container_active_work',
    });
  });

  it.each([
    null,
    'launching',
    'running',
    'sleeping',
    'recovering',
    'waking',
    'restoring',
    'degraded',
  ] as Array<VmAgentContainerLifecycleStatus | null>)(
    'keeps %s lifecycle state resumable and inconclusive',
    (status) => {
      expect(classifyVmAgentContainerLiveness(inspection(status, 'ended'))).toMatchObject({
        live: false,
        conclusive: false,
      });
    }
  );

  it.each(['stopping', 'stopped', 'expired', 'error'] as VmAgentContainerLifecycleStatus[])(
    'treats %s as conclusively terminal',
    (status) => {
      expect(classifyVmAgentContainerLiveness(inspection(status))).toEqual({
        live: false,
        conclusive: true,
        reason: `cf_container_${status}`,
      });
    }
  );
});
