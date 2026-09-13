import type { CapacityPoolStrategy } from '@simple-agent-manager/shared';

import {
  PLACEMENT_ROLLOUT_BASELINE_STRATEGY,
  resolvePlacementRollout,
} from '../../services/placement-rollout';
import type { TaskRunnerState } from './types';

/**
 * The effective pool's configured packing strategy for this run.
 *
 * A run with no capacity-pool selection is a legacy/unpooled placement: it keeps
 * the historical least-loaded ordering, which `balanced` reproduces exactly.
 */
export function taskPlacementStrategy(state: TaskRunnerState): CapacityPoolStrategy {
  const selection = state.config.capacityPoolSelection;
  if (!selection) return PLACEMENT_ROLLOUT_BASELINE_STRATEGY;
  return resolvePlacementRollout({
    userId: state.userId,
    poolId: selection.poolId,
    strategy: selection.strategy,
    cohortPercent: selection.selectionSettings?.rolloutCohortPercent,
  }).appliedStrategy;
}
