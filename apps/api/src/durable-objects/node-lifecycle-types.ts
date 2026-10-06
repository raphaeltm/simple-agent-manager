import type { NodeLifecycleStatus } from '@simple-agent-manager/shared';

import type { NodeLifecycleDeletionEnv } from './node-lifecycle-workspace-deletion';

export type NodeLifecycleEnv = NodeLifecycleDeletionEnv & {
  KV: KVNamespace;
  NODE_WARM_TIMEOUT_MS?: string;
  NODE_WORKSPACE_IDLE_TIMEOUT_MS?: string;
  NODE_ORPHAN_IDLE_TIMEOUT_MS?: string;
  NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS?: string;
  DO_ALARMS_ENABLED_KV_KEY?: string;
  CONTROL_LOOP_KILL_SWITCH_CACHE_MS?: string;
  CONTROL_LOOP_DISABLED_ALARM_RETRY_MS?: string;
};

export interface StoredState {
  nodeId: string;
  userId: string;
  status: NodeLifecycleStatus;
  warmSince: number | null;
  claimedByTask: string | null;
  /** Per-project warm timeout override (ms). Null = use platform default. */
  warmTimeoutOverrideMs?: number | null;
  /** First transition into destroying, used to bound this nudge-only alarm chain. */
  destroyingSince?: number;
}
