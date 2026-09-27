import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_SNAPSHOT_OPERATION_TIMEOUT_MS,
  getSessionSnapshotOperationTimeoutMs,
  hasTaskStepRetryBudget,
} from '../../../src/durable-objects/task-runner/snapshot-restore-retry';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';

function state(deadline: number | null | undefined): TaskRunnerState {
  return {
    currentStep: 'agent_session',
    retryCount: 3,
    config: { resumeSnapshotChatSessionId: 'chat' },
    stepResults: { snapshotRestoreDeadlineAt: deadline },
  } as TaskRunnerState;
}

describe('snapshot restore operation timeout configuration', () => {
  it.each([
    ['15m', 900_000],
    ['12m30s', 750_000],
    ['1h2m3s4ms', 3_723_004],
    ['250us', 0.25],
    ['500ns', 0.0005],
  ])('uses the VM cloud-init duration %s', (value, expected) => {
    expect(
      getSessionSnapshotOperationTimeoutMs({ SESSION_SNAPSHOT_OPERATION_TIMEOUT: value } as Env)
    ).toBe(expected);
  });

  it.each([
    undefined,
    '',
    '0s',
    '-1m',
    '15',
    'oops',
    '1m trailing',
    'Infinityh',
    '9'.repeat(400) + 'h',
  ])('falls back to the VM operation default for invalid duration %s', (value) => {
    expect(
      getSessionSnapshotOperationTimeoutMs({ SESSION_SNAPSHOT_OPERATION_TIMEOUT: value } as Env)
    ).toBe(DEFAULT_SESSION_SNAPSHOT_OPERATION_TIMEOUT_MS);
  });
});

describe('Go duration overflow parity', () => {
  it('accepts the exact Go int64 maximum including compound units', () => {
    const maximum = Number((1n << 63n) - 1n) / 1_000_000;
    for (const duration of ['9223372036854775807ns', '2562047h47m16s854ms775us807ns']) {
      expect(
        getSessionSnapshotOperationTimeoutMs({
          SESSION_SNAPSHOT_OPERATION_TIMEOUT: duration,
        } as Env)
      ).toBe(maximum);
    }
  });

  it.each(['100000000h', '9223372036854775808ns', '2562047h47m16s854ms775us808ns'])(
    'uses the VM default when %s exceeds Go time.Duration',
    (duration) => {
      expect(
        getSessionSnapshotOperationTimeoutMs({
          SESSION_SNAPSHOT_OPERATION_TIMEOUT: duration,
        } as Env)
      ).toBe(DEFAULT_SESSION_SNAPSHOT_OPERATION_TIMEOUT_MS);
    }
  );
});

describe('TaskRunner retry budget authority', () => {
  it('allows restore retries beyond the ordinary cap only before the fixed deadline', () => {
    const input = state(1000);
    expect(hasTaskStepRetryBudget(input, 3, 999)).toBe(true);
    expect(hasTaskStepRetryBudget(input, 3, 1000)).toBe(false);
    expect(hasTaskStepRetryBudget(input, 3, 1001)).toBe(false);
    input.retryCount = 0;
    expect(hasTaskStepRetryBudget(input, 3, 1000)).toBe(false);
  });

  it.each([null, undefined, NaN, Infinity])(
    'cannot extend retries with missing or malformed deadline %s',
    (deadline) => {
      expect(hasTaskStepRetryBudget(state(deadline), 3, 0)).toBe(false);
    }
  );

  it('ignores a restore deadline outside the snapshot agent-session step', () => {
    const input = state(1000);
    input.currentStep = 'workspace_ready';
    expect(hasTaskStepRetryBudget(input, 3, 0)).toBe(false);
    input.currentStep = 'agent_session';
    input.config.resumeSnapshotChatSessionId = null;
    expect(hasTaskStepRetryBudget(input, 3, 0)).toBe(false);
    input.retryCount = 2;
    expect(hasTaskStepRetryBudget(input, 3, 0)).toBe(true);
  });
});
