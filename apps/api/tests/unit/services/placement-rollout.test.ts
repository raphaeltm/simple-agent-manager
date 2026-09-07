import { describe, expect, it } from 'vitest';

import { taskPlacementStrategy } from '../../../src/durable-objects/task-runner/node-selection';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';
import { resolvePlacementRollout } from '../../../src/services/placement-rollout';
import {
  comparePlacementHostsByStrategy,
  type PlacementHostSignals,
} from '../../../src/services/placement-strategy';

const input = { userId: 'user', poolId: 'pool', strategy: 'pack' as const };
function state(percent: number): TaskRunnerState {
  return {
    userId: input.userId,
    config: {
      capacityPoolSelection: {
        poolId: input.poolId,
        strategy: input.strategy,
        selectionSettings: { rolloutCohortPercent: percent },
      },
    },
  } as unknown as TaskRunnerState;
}
const host = (id: string, projectedUtilization: number): PlacementHostSignals => ({
  nodeId: id,
  cpuMillisCapacity: 8000,
  cpuMillisCommitted: 0,
  memoryMbCapacity: 16384,
  memoryMbCommitted: 0,
  diskMbCapacity: 80000,
  diskMbCommitted: 0,
  coTenantCount: 1,
  projectedUtilization,
  observedLoadScore: 10,
  capacitySource: 'observed',
  locationKey: 'hetzner:fsn1',
});

describe('ranking rollout on the same eligible host set', () => {
  it('shadows configured strategy at zero percent and applies it at full rollout', () => {
    const hosts = [host('emptier', 0.2), host('fuller', 0.8)];
    const winner = (percent: number) =>
      [...hosts].sort((a, b) =>
        comparePlacementHostsByStrategy(a, b, taskPlacementStrategy(state(percent)))
      )[0]?.nodeId;
    expect(winner(0)).toBe('emptier');
    expect(winner(100)).toBe('fuller');
    expect(resolvePlacementRollout({ ...input, cohortPercent: 0 })).toMatchObject({
      mode: 'shadow',
      appliedStrategy: 'balanced',
      configuredStrategy: 'pack',
    });
  });
  it('is stable across retries and assigns nested cohorts as rollout increases', () => {
    for (let index = 0; index < 100; index++) {
      const identity = { ...input, userId: `user-${index}` };
      const low = resolvePlacementRollout({ ...identity, cohortPercent: 20 });
      expect(resolvePlacementRollout({ ...identity, cohortPercent: 20 })).toEqual(low);
      if (low.mode === 'enabled')
        expect(resolvePlacementRollout({ ...identity, cohortPercent: 80 }).mode).toBe('enabled');
    }
  });
  it('keeps old plans readable and defaults absent rollout settings to configured behavior', () => {
    const old = state(100);
    Reflect.deleteProperty(old.config.capacityPoolSelection!, 'selectionSettings');
    expect(taskPlacementStrategy(old)).toBe('pack');
  });
});
