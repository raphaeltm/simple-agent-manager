/** Configuration used by the scheduled TaskRunner/D1 lifecycle reconciler. */
export interface TaskRecoveryEnv {
  TASK_DO_MISMATCH_GRACE_MS?: string;
  STUCK_TASK_MAX_CANDIDATES_PER_SWEEP?: string;
  STUCK_TASK_SCAN_CURSOR_KV_KEY?: string;
  TASK_LIVENESS_MAX_ACP_SESSIONS?: string;
  TASK_LIVENESS_PROBE_TIMEOUT_MS?: string;
  TASK_RUN_ABSOLUTE_CEILING_MS?: string;
}
