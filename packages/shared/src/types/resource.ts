import type { VMSize } from './workspace';

// =============================================================================
// Resource Requirements (user/admin-facing)
// =============================================================================

/**
 * User-facing resource requirements. All fields are optional to support
 * inheritance — unset fields inherit from the next level in the precedence
 * chain (task > trigger > agent-profile > project > platform).
 */
export interface ResourceRequirements {
  /** Minimum vCPU count (maps to VM size). */
  minVcpu?: number;
  /** Minimum memory in GB. */
  minMemoryGb?: number;
  /** Minimum disk in GB. */
  minDiskGb?: number;
  /** If true, the task must have a node to itself (no co-tenants). */
  exclusiveNode?: boolean;
  /** Maximum number of workspaces sharing a node (1 = exclusive). */
  maxCoTenants?: number;
}

// =============================================================================
// Resource Requirements Source (provenance tracking)
// =============================================================================

/** Where the resolved resource requirements came from. */
export type ResourceRequirementsSource =
  | 'task'
  | 'trigger'
  | 'skill'
  | 'agent-profile'
  | 'project'
  | 'user'
  | 'platform';

// =============================================================================
// Resolved Resource Reservation (scheduler-facing)
// =============================================================================

/**
 * Scheduler-facing resolved reservation. All fields are concrete (no optionals)
 * and use integer units to avoid float math in DB queries.
 */
export interface ResolvedResourceReservation {
  /** CPU reservation in millicores (1000 = 1 vCPU). */
  cpuMillis: number;
  /** Memory reservation in MB. */
  memoryMb: number;
  /** Disk reservation in MB. */
  diskMb: number;
  /** Whether this task requires exclusive node access. */
  exclusiveNode: boolean;
  /** Max co-tenants allowed on the same node. */
  maxCoTenants: number;
  /** Which level in the precedence chain provided the requirements. */
  source: ResourceRequirementsSource;
  /** ID of the source entity (profile ID, project ID, 'platform', etc.). */
  sourceId: string;
  /** Schema version for forward compatibility. */
  version: number;
}

// =============================================================================
// Placement Explanation (audit trail)
// =============================================================================

/** Audit record explaining why a task was placed on a particular node/VM size. */
export interface PlacementExplanation {
  /** The VM size that was selected. */
  selectedVmSize: VMSize;
  /** Where the VM size came from. */
  vmSizeSource: ResourceRequirementsSource | 'explicit';
  /** The resolved reservation used for the decision. */
  reservation: ResolvedResourceReservation;
  /** Human-readable explanation of the placement decision. */
  reason: string;
  /** Timestamp of the placement decision. */
  decidedAt: string;
}

// =============================================================================
// Resolution Input (collector for the precedence chain)
// =============================================================================

/** Input layers for resource resolution, in descending priority order. */
export interface ResourceResolutionInput {
  /** Task-level explicit override (SubmitTaskRequest.resourceRequirements). */
  task?: ResourceRequirements;
  /** Trigger-level override (from trigger config). */
  trigger?: ResourceRequirements;
  /** Skill-level default. */
  skill?: ResourceRequirements;
  /** Agent profile default. */
  agentProfile?: ResourceRequirements;
  /** Project-level default. */
  project?: ResourceRequirements;
  /** User-level default (future). */
  user?: ResourceRequirements;
}
