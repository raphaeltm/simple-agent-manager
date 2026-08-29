import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';

import {
  capacityPlacementSnapshotForTaskStart,
  capacityPoolNoCandidatesMessage,
  hasNoCapacityPoolCandidates,
  resolveTaskStartCapacityPoolSelection,
  type TaskStartCapacityPoolSelection,
  type TaskStartPlacement,
} from '../../services/placement-resolver';
import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse } from './_helpers';

export async function resolveDispatchCapacityPlacement(input: {
  db: Parameters<typeof resolveTaskStartCapacityPoolSelection>[0];
  placement: TaskStartPlacement;
  isInstantRuntime: boolean;
  requestId: string | number | null;
}): Promise<
  | { error: JsonRpcResponse }
  | {
      capacityPoolSelection: TaskStartCapacityPoolSelection | null;
      capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
    }
> {
  const capacityPoolSelection = input.isInstantRuntime
    ? null
    : await resolveTaskStartCapacityPoolSelection(input.db, input.placement);
  if (capacityPoolSelection && hasNoCapacityPoolCandidates(capacityPoolSelection)) {
    return {
      error: jsonRpcError(
        input.requestId,
        INVALID_PARAMS,
        capacityPoolNoCandidatesMessage(capacityPoolSelection)
      ),
    };
  }

  return {
    capacityPoolSelection,
    capacityPlacementSnapshot: capacityPlacementSnapshotForTaskStart(capacityPoolSelection),
  };
}
