import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import type { PlacementHostDiagnosticInput } from '../../services/placement-diagnostics';
import {
  comparePlacementHostsByStrategy,
  type PlacementHostSignals,
} from '../../services/placement-strategy';
import {
  WORKSPACE_BUSY_BUILD_QUEUE_REASON,
} from '../../services/workspace-resource-capacity';
import { updatePlacementDiagnostics } from './placement-diagnostics';
import { taskPlacementStrategy } from './task-placement-strategy';
import type { TaskRunnerState } from './types';

export interface ReusableNodeSelection {
  nodeId: string;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
}

export interface ReusableNodeDeferral {
  kind: 'deferrable';
  nodeId: string;
  reason: typeof WORKSPACE_BUSY_BUILD_QUEUE_REASON;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
}

export type ReusableNodePlacementResult =
  | { kind: 'selected'; selection: ReusableNodeSelection }
  | ReusableNodeDeferral;

export type DeferrableReusableNodeCandidate = {
  id: string;
  vmLocation: string;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
  signals: PlacementHostSignals;
};

export function selectReusableNodeDeferral(
  state: TaskRunnerState,
  diagnosticHosts: PlacementHostDiagnosticInput[],
  deferrableCandidates: DeferrableReusableNodeCandidate[]
): ReusableNodeDeferral | null {
  if (!deferrableCandidates.length) return null;

  const strategy = taskPlacementStrategy(state);
  const selectionSettings = state.config.capacityPoolSelection?.selectionSettings;
  deferrableCandidates.sort((a, b) => {
    const aLoc = a.vmLocation === state.config.vmLocation ? 1 : 0;
    const bLoc = b.vmLocation === state.config.vmLocation ? 1 : 0;
    if (aLoc !== bLoc) return bLoc - aLoc;
    return comparePlacementHostsByStrategy(a.signals, b.signals, strategy, selectionSettings);
  });

  updatePlacementDiagnostics(state, { hosts: diagnosticHosts, selectedNodeId: null });
  const bestDeferrable = deferrableCandidates[0];
  if (!bestDeferrable) return null;

  log.info('task_runner_do.node_capacity_deferred', {
    taskId: state.taskId,
    nodeId: bestDeferrable.id,
    reason: WORKSPACE_BUSY_BUILD_QUEUE_REASON,
  });

  return {
    kind: 'deferrable',
    nodeId: bestDeferrable.id,
    reason: WORKSPACE_BUSY_BUILD_QUEUE_REASON,
    capacityPlacementSnapshot: bestDeferrable.capacityPlacementSnapshot,
  };
}
