import type { TaskStartCapacityCandidate } from '../../services/placement-resolver';
import { rankCapacityCandidatesForRuntime } from '../../services/placement-resolver';
import {
  buildPlacementLocationInventory,
  type PlacementLocationInventory,
} from '../../services/placement-strategy';
import { getTaskReservation } from './node-selection';
import { taskPlacementStrategy } from './task-placement-strategy';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/** Rank permissible offerings against the caller's live host distribution. */
export async function rankProvisioningCandidates(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<TaskStartCapacityCandidate[]> {
  const selection = state.config.capacityPoolSelection;
  const candidates = selection?.candidates ?? [];
  if (candidates.length <= 1) return [...candidates];

  const strategy = taskPlacementStrategy(state);
  let locationInventory: PlacementLocationInventory | undefined;
  if (strategy === 'pack' || strategy === 'spread') {
    // Only distribution-sensitive strategies pay for this read. The resolver
    // cannot otherwise distinguish packing from spreading a new offering.
    const hosts = await rc.env.DATABASE.prepare(
      `SELECT cloud_provider AS cloudProvider, vm_location AS vmLocation
         FROM nodes
        WHERE user_id = ?
          AND status IN ('running', 'creating', 'recovery')
          AND node_role = 'workspace'
          AND (runtime IS NULL OR runtime != 'cf-container')`
    )
      .bind(state.userId)
      .all<{ cloudProvider: string | null; vmLocation: string | null }>();
    locationInventory = buildPlacementLocationInventory(hosts.results);
  }

  return rankCapacityCandidatesForRuntime(candidates, {
    strategy,
    reservation: getTaskReservation(state),
    settings: selection?.selectionSettings,
    locationInventory,
  });
}
