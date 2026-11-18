/**
 * Environment variables scheduler-core reads. The worker's `Env` extends this interface, so
 * package functions never receive the full worker environment.
 */
export interface WorkspaceAdmissionEnv {
  TASK_RUN_NODE_CPU_THRESHOLD_PERCENT?: string;
  TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT?: string;
  TASK_RUN_NODE_CPU_SHARE_BUDGET_PERCENT?: string;
  TASK_RUN_NODE_HOST_MEMORY_RESERVE_MB?: string;
  TASK_RUN_NODE_DISK_PRESSURE_THRESHOLD_PERCENT?: string;
  TASK_RUN_NODE_METRICS_TTL_MS?: string;
  TASK_RUN_NODE_CPU_SCORE_WEIGHT_PERCENT?: string;
  TASK_RUN_NODE_MEMORY_SCORE_WEIGHT_PERCENT?: string;
  /** Legacy fallback for `TASK_RUN_NODE_HOST_MEMORY_RESERVE_MB`; also read by cloud-init. */
  VM_AGENT_MEMORY_RESERVE_MB?: string;
}
