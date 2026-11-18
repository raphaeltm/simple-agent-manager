import { describe, expect, it, vi } from 'vitest';

import {
  persistProviderLimitRecoveryNudge,
  putTaskRunnerState,
} from '../../../src/durable-objects/task-runner/attempt-storage';
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

function storageAt(current: TaskRunnerState | null) {
  let persisted = structuredClone(current);
  const put = vi.fn(async (_key: string, value: TaskRunnerState) => {
    persisted = structuredClone(value);
  });
  const setAlarm = vi.fn();
  const storage = {
    transaction: async (callback: (value: unknown) => Promise<boolean>) =>
      callback({
        get: async () => structuredClone(persisted),
        put,
        setAlarm,
      }),
  } as unknown as DurableObjectStorage;
  return { storage, put, setAlarm, read: () => persisted };
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

  it.each(['absent', 'null', 'older grant'])(
    'retains nudged consent when a stale same-attempt step write carries %s approval',
    async (incoming) => {
      const step = structuredClone(observed);
      if (incoming === 'null') step.config.providerLimitRecoveryApproval = null;
      if (incoming === 'older grant')
        step.config.providerLimitRecoveryApproval = { ...approval, receipt: 'older-consent' };
      const state = storageAt(observed);
      expect(await persistProviderLimitRecoveryNudge(state.storage, observed, approval)).toBe(true);
      step.currentStep = 'workspace_ready';
      step.stepResults.nodeId = 'node-selected-by-step';
      await putTaskRunnerState(state.storage, {} as D1Database, step);
      expect(step.config.providerLimitRecoveryApproval).toEqual(approval);
      expect(state.read()).toMatchObject({
        currentStep: 'workspace_ready',
        stepResults: { nodeId: 'node-selected-by-step' },
        config: { providerLimitRecoveryApproval: approval },
      });
    }
  );

  it.each([
    'attempt',
    'completed',
    'running',
    'owner',
    'task',
    'project',
    'awaiting_followup',
    'missing',
  ])('does not write state or alarm after concurrent %s supersession', async (change) => {
    const current = structuredClone(observed);
    if (change === 'attempt') current.config.recoveryAttemptId = 'new-attempt';
    if (change === 'completed') current.completed = true;
    if (change === 'running') current.currentStep = 'running';
    if (change === 'owner') current.userId = 'other-owner';
    if (change === 'task') current.taskId = 'other-task';
    if (change === 'project') current.projectId = 'other-project';
    if (change === 'awaiting_followup') current.currentStep = 'awaiting_followup';
    const { storage, put, setAlarm } = storageAt(change === 'missing' ? null : current);
    expect(await persistProviderLimitRecoveryNudge(storage, observed, approval)).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(setAlarm).not.toHaveBeenCalled();
  });
});
