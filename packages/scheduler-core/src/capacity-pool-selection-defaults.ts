import type { CapacityPoolPlacementSettings } from '@simple-agent-manager/shared';
import { LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION } from '@simple-agent-manager/shared';

/**
 * Code defaults for capacity pool selection. The worker's persisted settings resolver
 * (`resolveCapacityPoolPlacementSettings`) starts from these and overlays stored values.
 */
export const DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS: Pick<
  CapacityPoolPlacementSettings,
  | 'version'
  | 'sourceGeneration'
  | 'legacyWorkloadAdapterVersion'
  | 'selectionWeights'
  | 'rolloutCohortPercent'
> = {
  version: 1,
  sourceGeneration: 1,
  legacyWorkloadAdapterVersion: LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION,
  selectionWeights: {
    priority: 100_000_000,
    price: 1,
    fit: 1_000_000,
    capacity: 1,
    candidateOrder: 1,
  },
  rolloutCohortPercent: 100,
};
