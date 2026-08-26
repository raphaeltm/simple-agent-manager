import type { AcpSessionStatus } from '@simple-agent-manager/shared';

export interface TaskRuntimeLiveness {
  live: boolean;
  conclusive: boolean;
  reason: string;
  workspaceStatus: string | null;
  nodeId: string | null;
  activeAcpSessionId: string | null;
}

export type RuntimeProbeOutcome = 'ok' | 'timeout' | 'error' | 'unknown' | 'not_run';
export type NodeHealthProbeOutcome = 'ok' | 'failed' | 'timeout' | 'error' | 'not_run';

export interface RuntimeWorkspaceSnapshot {
  id: string;
  status: string;
  chatSessionId: string | null;
  nodeId: string | null;
  nodeRuntime: string | null;
  nodeStatus: string | null;
  nodeHealthStatus: string | null;
  nodeHeartbeatAt: number | null;
  runningWorkspacesOnNode: number | null;
}

export interface RuntimeAcpSessionSnapshot {
  id: string;
  status: AcpSessionStatus;
  workspaceId: string | null;
  lastHeartbeatAt: number | null;
  updatedAt: number;
  startedAt: number | null;
  createdAt: number;
}

export interface RuntimeSessionWorkSnapshot {
  active: boolean;
  activeAcpSessionId: string;
  reason: 'task_prompt_turn_active' | 'task_runtime_work_active';
}

export interface TaskAcpLivenessSignals {
  sessions: RuntimeAcpSessionSnapshot[];
  total: number;
  sessionWork: RuntimeSessionWorkSnapshot | null;
}

export interface ContainerLifecycleSnapshot {
  status: string | null;
  activeWorkStatus: string | null;
}

/**
 * The `session_snapshots` sleep record — the authoritative answer to "can this
 * session still be restored?". Deliberately mirrors the gate the resumer
 * actually applies, so the classifier and the resumer cannot disagree about
 * what "gone" means (`.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`).
 *
 * The resume path is two functions, and this type carries the inputs to both:
 *  - `session-recovery.ts:loadRecoveryContext` — requires `workspaceId`,
 *    a matching `projectId`, and `sleepingAt`.
 *  - `session-snapshot-recovery-lifecycle.ts:claimSessionSnapshotRecovery` —
 *    the function that actually authorizes a wake. It additionally requires a
 *    restorable `status`/`degradation` pair, an unexpired `expires_at`, and
 *    `recovery_attempts < SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`.
 */
export interface SessionResumabilitySnapshot {
  chatSessionId: string;
  projectId: string | null;
  workspaceId: string | null;
  /** ms epoch; null when the session was never slept. */
  sleepingAt: number | null;
  sleepStatus: string | null;
  /** ms epoch; null when absent or unparseable. */
  expiresAtMs: number | null;
  status: string | null;
  degradation: string | null;
  recoveryAttempts: number;
}

export type ResumabilityProbeOutcome = 'ok' | 'error' | 'not_run';

export type SupersessionProbeOutcome = 'ok' | 'error' | 'not_run';

/**
 * How this task's recovery family relates to it.
 *  - `none`     — no newer wake successor exists; this task was never superseded.
 *  - `live`     — a newer, non-terminal successor owns the conversation right now.
 *  - `terminal` — this task WAS superseded, and the whole family has since ended.
 *
 * `terminal` is deliberately distinct from `none`. The task is dead either way,
 * but it ended because its conversation moved on, not because its runtime died,
 * so it must never be recorded as a failure (`.claude/rules/66`).
 */
export type TaskSupersession = 'none' | 'live' | 'terminal';

export interface TaskRuntimeLivenessSignals {
  /** The task's project — re-checked against the snapshot row in memory. */
  projectId: string;
  taskWorkspaceId: string | null;
  workspace: RuntimeWorkspaceSnapshot | null;
  workspaceProbeOutcome: 'ok' | 'error' | 'unknown';
  nowMs: number;
  heartbeatStaleMs: number;
  acpProbeOutcome: RuntimeProbeOutcome;
  nodeHealthProbeOutcome: NodeHealthProbeOutcome;
  acpSessions: RuntimeAcpSessionSnapshot[];
  /**
   * Positive local ProjectData evidence that the ACP prompt turn or harness
   * runtime work is still in flight. This is intentionally separate from ACP
   * heartbeats: storage/alarm pressure can starve heartbeat writes while the
   * same DO still has fresher prompt/runtime-work state.
   */
  sessionWork: RuntimeSessionWorkSnapshot | null;
  containerProbeOutcome: RuntimeProbeOutcome;
  containerLifecycle: ContainerLifecycleSnapshot | null;
  /**
   * `not_run` preserves the pre-resumability behaviour for callers that cannot
   * reach D1; `error` withholds a conclusive-death verdict because the
   * alternative is terminalizing a session that may still be restorable.
   */
  resumabilityProbeOutcome: ResumabilityProbeOutcome;
  sessionResumability: SessionResumabilitySnapshot | null;
  /**
   * `SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS` as the resumer resolves it, so the
   * classifier applies the same wake-attempt ceiling the claim does.
   */
  resumabilityMaxRecoveryAttempts: number;
  /**
   * `not_run` preserves the pre-supersession behaviour for callers that cannot
   * reach D1; `error` withholds a conclusive-death verdict because the
   * alternative is failing a task whose conversation is demonstrably alive.
   */
  supersessionProbeOutcome: SupersessionProbeOutcome;
  /** How this task's recovery family relates to it. See `loadTaskSupersession`. */
  supersession: TaskSupersession;
}

export interface TaskLivenessNodeHealthProbeEnv {
  BASE_DOMAIN?: string;
  VM_AGENT_PROTOCOL?: string;
  VM_AGENT_PORT?: string;
  TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS?: string;
}

export interface TaskLivenessNodeHealthProbeResult {
  outcome: Exclude<NodeHealthProbeOutcome, 'not_run'>;
  timeoutMs: number;
  url: string | null;
  status: number | null;
  error: string | null;
}
