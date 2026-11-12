import { describe, expect, it, vi } from 'vitest';

import { persistProviderLimitRecoveryNudge } from '../../../src/durable-objects/task-runner/attempt-storage';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';
import type { ProviderLimitRecoveryApproval } from '../../../src/services/provider-limit-recovery-approval';

const approval: ProviderLimitRecoveryApproval = {
  receipt: '{}',
  ownerUserId: 'owner',
  snapshotId: 'snapshot',
  expiresAt: 1,
  sourceCredentialReference: 'credential',
};
const observed = {
  taskId: 'task',
  projectId: 'project',
  userId: 'owner',
  completed: false,
  currentStep: 'node_selection',
  config: { recoveryAttemptId: 'attempt' },
  stepResults: { nodeId: null },
} as unknown as TaskRunnerState;

function storageAt(current: TaskRunnerState) {
  const put = vi.fn();
  const setAlarm = vi.fn();
  const storage = {
    transaction: async (callback: (value: unknown) => Promise<boolean>) =>
      callback({
        get: async () => structuredClone(current),
        put,
        setAlarm,
      }),
  } as unknown as DurableObjectStorage;
  return { storage, put, setAlarm };
}

describe('provider limit approval nudge persistence after an external D1 await', () => {
  it('merges approval into advanced current state rather than overwriting it with the observed state', async () => {
    const current = structuredClone(observed);
    current.currentStep = 'workspace_ready';
    current.stepResults.nodeId = 'allocated-during-read';
    const { storage, put, setAlarm } = storageAt(current);
    expect(await persistProviderLimitRecoveryNudge(storage, observed, approval)).toBe(true);
    expect(put).toHaveBeenCalledWith('state', {
      ...current,
      config: { ...current.config, providerLimitRecoveryApproval: approval },
    });
    expect(setAlarm).toHaveBeenCalledOnce();
    expect(observed.config.providerLimitRecoveryApproval).toBeUndefined();
  });

  it.each(['attempt', 'completed', 'running', 'owner'])(
    'does not write state or alarm after concurrent %s supersession',
    async (change) => {
      const current = structuredClone(observed);
      if (change === 'attempt') current.config.recoveryAttemptId = 'new-attempt';
      if (change === 'completed') current.completed = true;
      if (change === 'running') current.currentStep = 'running';
      if (change === 'owner') current.userId = 'other-owner';
      const { storage, put, setAlarm } = storageAt(current);
      expect(await persistProviderLimitRecoveryNudge(storage, observed, approval)).toBe(false);
      expect(put).not.toHaveBeenCalled();
      expect(setAlarm).not.toHaveBeenCalled();
    }
  );
});
