import {
  comparePlacementRolloutHosts,
  resolvePlacementRollout,
} from '@simple-agent-manager/scheduler-core';
import {
  comparePlacementHostsByStrategy,
  type PlacementHostSignals,
} from '@simple-agent-manager/scheduler-core';
import { describe, expect, it } from 'vitest';

import { taskPlacementStrategy } from '../../../src/durable-objects/task-runner/node-selection';
import { compareReusableHosts } from '../../../src/durable-objects/task-runner/task-placement-strategy';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';

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
const host = (
  id: string,
  projectedUtilization: number,
  startupBacklog = 0
): PlacementHostSignals => ({
  nodeId: id,
  cpuMillisCapacity: 8000,
  cpuMillisCommitted: 0,
  memoryMbCapacity: 16384,
  memoryMbCommitted: 0,
  diskMbCapacity: 80000,
  diskMbCommitted: 0,
  coTenantCount: 1,
  startupBacklog,
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
  it('compares strategies only below the backlog tier the real selection ranks first', () => {
    const runState = state(100);
    runState.config.vmLocation = 'fsn1';
    const candidates = [
      { id: 'emptier-queued', vmLocation: 'fsn1', signals: host('emptier-queued', 0.2, 3) },
      { id: 'fuller-queued', vmLocation: 'fsn1', signals: host('fuller-queued', 0.8, 3) },
      { id: 'idle', vmLocation: 'fsn1', signals: host('idle', 0.5, 0) },
    ];
    const rollout = comparePlacementRolloutHosts({
      ...input,
      settings: runState.config.capacityPoolSelection?.selectionSettings,
      candidates,
      compare: (a, b, strategy) => compareReusableHosts(runState, a, b, strategy),
    });
    // Both strategies pick the node the TaskRunner picks: the one with no queued startups.
    expect(rollout).toMatchObject({
      baselineSelectedNodeId: 'idle',
      configuredSelectedNodeId: 'idle',
      differenceReasons: ['same-selection'],
    });
  });
  it('keeps old plans readable and defaults absent rollout settings to configured behavior', () => {
    const old = state(100);
    Reflect.deleteProperty(old.config.capacityPoolSelection!, 'selectionSettings');
    expect(taskPlacementStrategy(old)).toBe('pack');
  });
});
