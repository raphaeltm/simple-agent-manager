import type {
  CapacityPoolPlacementSettings,
  CapacityPoolStrategy,
  PlacementRolloutDiagnostic,
} from '@simple-agent-manager/shared';

import { DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS } from './capacity-pool-placement-settings';
import { comparePlacementHostsByStrategy, type PlacementHostSignals } from './placement-strategy';

// FNV-1a provides a stable cohort across isolates, retries and version rollbacks.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const COHORT_BUCKETS = 10000;
const PERCENT_SCALE = 100;
export const PLACEMENT_ROLLOUT_BASELINE_STRATEGY: CapacityPoolStrategy = 'balanced';

/** Rollout changes ranking only. Both choices consume the same authority-filtered candidates. */
export function resolvePlacementRollout(input: {
  userId: string;
  poolId: string;
  strategy: CapacityPoolStrategy;
  cohortPercent?: number;
}): PlacementRolloutDiagnostic {
  const percent =
    input.cohortPercent ?? DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.rolloutCohortPercent;
  const cohortPercent =
    Number.isFinite(percent) && percent >= 0 && percent <= PERCENT_SCALE
      ? percent
      : DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.rolloutCohortPercent;
  let hash = FNV_OFFSET;
  for (const character of `${input.userId}:${input.poolId}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), FNV_PRIME) >>> 0;
  }
  const enabled = hash % COHORT_BUCKETS < cohortPercent * PERCENT_SCALE;
  return {
    cohortPercent,
    mode: enabled ? 'enabled' : 'shadow',
    configuredStrategy: input.strategy,
    appliedStrategy: enabled ? input.strategy : PLACEMENT_ROLLOUT_BASELINE_STRATEGY,
    baselineSelectedNodeId: null,
    configuredSelectedNodeId: null,
    differenceReasons: [],
  };
}

/** Compare strategies only after the caller has applied every admission constraint. */
export function comparePlacementRolloutHosts(input: {
  userId: string;
  poolId: string;
  strategy: CapacityPoolStrategy;
  settings?: CapacityPoolPlacementSettings;
  location: string;
  candidates: ReadonlyArray<{ id: string; vmLocation: string; signals: PlacementHostSignals }>;
}): PlacementRolloutDiagnostic {
  const rollout = resolvePlacementRollout({
    ...input,
    cohortPercent: input.settings?.rolloutCohortPercent,
  });
  const rankFor = (strategy: CapacityPoolStrategy) =>
    [...input.candidates].sort((a, b) => {
      const locality =
        Number(b.vmLocation === input.location) - Number(a.vmLocation === input.location);
      return (
        locality || comparePlacementHostsByStrategy(a.signals, b.signals, strategy, input.settings)
      );
    })[0]?.id ?? null;
  rollout.baselineSelectedNodeId = rankFor(PLACEMENT_ROLLOUT_BASELINE_STRATEGY);
  rollout.configuredSelectedNodeId = rankFor(input.strategy);
  rollout.differenceReasons = [
    !input.candidates.length
      ? 'no-eligible-hosts'
      : rollout.baselineSelectedNodeId === rollout.configuredSelectedNodeId
        ? 'same-selection'
        : 'strategy-order-differs',
  ];
  return rollout;
}
