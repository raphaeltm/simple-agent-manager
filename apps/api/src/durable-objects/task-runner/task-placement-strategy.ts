import type { CapacityPoolStrategy } from '@simple-agent-manager/shared';

import {
  PLACEMENT_ROLLOUT_BASELINE_STRATEGY,
  resolvePlacementRollout,
} from '../../services/placement-rollout';
import {
  comparePlacementHostsByStrategy,
  type PlacementHostSignals,
} from '../../services/placement-strategy';
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

/** A reusable host as the TaskRunner ranks it. */
export interface RankableReusableHost {
  vmLocation: string | null;
  signals: PlacementHostSignals;
}

/**
 * Order admitted reusable hosts for this run. Lower sorts first. Every host passed in has
 * already cleared the capacity gate, so this only ranks; it never admits.
 *
 * Startup backlog (`signals.startupBacklog`) comes before the pool strategy. A node builds one
 * workspace at a time, so a start placed behind five queued builds waits for all five: on
 * 2026-11-08 that was 17 minutes for a 3-minute setup, while `pack` had ranked that node first
 * because the queued reservations made it look fullest. Preferring the shorter queue among
 * hosts that already fit distributes a burst across existing nodes without adding build
 * concurrency or provisioning anything.
 *
 * An explicit location stays ahead of backlog: the caller asked for that locality. A default
 * location (`explicitVmLocation === false`) is only a tie-break after backlog. A run started
 * before the flag existed has it absent and keeps the earlier order, location first.
 */
export function compareReusableHosts(
  state: TaskRunnerState,
  a: RankableReusableHost,
  b: RankableReusableHost
): number {
  const explicitLocation = state.config.explicitVmLocation !== false;
  const location = compareLocation(state, a, b);
  if (explicitLocation && location !== 0) return location;

  const backlog = a.signals.startupBacklog - b.signals.startupBacklog;
  if (backlog !== 0) return backlog;

  if (!explicitLocation && location !== 0) return location;

  return comparePlacementHostsByStrategy(
    a.signals,
    b.signals,
    taskPlacementStrategy(state),
    state.config.capacityPoolSelection?.selectionSettings
  );
}

function compareLocation(
  state: TaskRunnerState,
  a: RankableReusableHost,
  b: RankableReusableHost
): number {
  const aMatches = a.vmLocation === state.config.vmLocation ? 1 : 0;
  const bMatches = b.vmLocation === state.config.vmLocation ? 1 : 0;
  return bMatches - aMatches;
}
