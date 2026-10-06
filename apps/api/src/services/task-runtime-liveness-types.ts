import type { AcpSessionStatus } from '@simple-agent-manager/shared';

export interface TaskRuntimeLiveness {
  live: boolean;
  conclusive: boolean;
  reason: string;
  workspaceStatus: string | null;
  nodeId: string | null;
  activeAcpSessionId: string | null;
  deliveryTarget?: { nodeId: string; userId: string };
  /**
   * What a verdict that rests on the task's own ACP session actually observed.
   * Diagnostics only: it never feeds a decision. Absent for verdicts that do not
   * name an ACP session.
   */
  evidence?: TaskRuntimeLivenessEvidence;
}

/**
 * What ProjectData reports about one ACP session's work. The first two states are
 * exactly the ones that make `sessionWork` active, and both come from the same
 * per-row classifier, so a description can never disagree with the verdict.
 *
 * - `prompt_turn_active`: a working activity (`prompting`/`recovering`) with
 *   evidence fresher than `SESSION_ACTIVITY_STALE_THRESHOLD_MS`.
 * - `runtime_work_active`: a fresh harness work lease (tool or background work).
 * - `prompt_turn_unproven`: a working activity whose evidence is older than that
 *   bound. Unproven, not false (`.claude/rules/57`): a long tool call or a
 *   wedged prompt both look like this.
 * - `idle`: the agent handed control back and holds no work lease.
 * - `unknown`: no session state, or a label (`error`, `stopped`) that says
 *   nothing about in-flight work.
 */
export type RuntimeWorkState =
  'prompt_turn_active' | 'runtime_work_active' | 'prompt_turn_unproven' | 'idle' | 'unknown';

/** One ACP session's work evidence, as ProjectData stores it. No prompt content. */
export interface RuntimeWorkEvidenceSnapshot {
  acpSessionId: string;
  state: RuntimeWorkState;
  /** `session_state.activity`, limited to the known labels; anything else is null. */
  activity: string | null;
  /** ms epoch of the last activity transition or work report. */
  activityAt: number | null;
  /** ms epoch the current prompt turn started; null when no turn is recorded. */
  promptStartedAt: number | null;
  /** ms epoch of the last harness work progress edge. */
  runtimeWorkProgressAt: number | null;
}

/** `RuntimeWorkEvidenceSnapshot` as ages at classification time, plus the ACP heartbeat age. */
export interface TaskRuntimeLivenessEvidence {
  workState: RuntimeWorkState | null;
  activity: string | null;
  lastActivityAgeMs: number | null;
  promptStartedAgeMs: number | null;
  runtimeWorkProgressAgeMs: number | null;
  acpHeartbeatAgeMs: number | null;
}

/**
 * Bound on the recursive supersession walk in `loadTaskSupersession`. The query is
 * only reached for a task already about to receive a terminal verdict, and the cap
 * stops a corrupt cycle from making the sweep unbounded (`.claude/rules/47`).
 *
 * Lives in this dependency-free module because both `task-runtime-liveness.ts` and
 * `task-runtime-liveness-loaders.ts` need it, and the former re-exports from the
 * latter — so putting it in either would create an import cycle.
 */
export const MAX_TASK_SUPERSESSION_CHAIN_DEPTH = 32;

export type RuntimeProbeOutcome = 'ok' | 'timeout' | 'error' | 'unknown' | 'not_run';
export type NodeHealthProbeOutcome = 'ok' | 'failed' | 'timeout' | 'error' | 'not_run';

/**
 * Result of the task-scoped sleep lookup in `task-sleep-preservation.ts`.
 *
 * `preserve` — the wake path would still accept this session; withhold the verdict.
 * `none`     — no restorable or in-flight sleep record; the caller may terminalize.
 * `unknown`  — the lookup failed; withhold the verdict, because destroying is the
 *              irreversible direction (`.claude/rules/58` requirement 4).
 * `not_run`  — the caller has no chat session to look up, or cannot reach D1.
 */
export type TaskSessionSleepOutcome = 'not_run' | 'none' | 'preserve' | 'unknown';

export interface RuntimeWorkspaceSnapshot {
  id: string;
  status: string;
  /**
   * `workspaces.created_at` in epoch ms — the start of the CURRENT runtime
   * generation, which is what the runaway-cost ceiling must age from. A wake
   * allocates a fresh workspace, so this advances with each incarnation while
   * `tasks.started_at` does not. Null when the column is absent or unparseable,
   * which callers must treat as "fall back to the stricter existing signal".
   */
  createdAtMs: number | null;
  chatSessionId: string | null;
  nodeId: string | null;
  userId: string | null;
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
  /** Work evidence per active ACP session, newest first. Diagnostics only. */
  workEvidence?: RuntimeWorkEvidenceSnapshot[];
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
 *    restorable `status`/`degradation` pair, an unexpired `expires_at`, and an
 *    available attempt budget — `recovery_attempts <
 *    SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`, OR a spent budget whose last clean
 *    failure is older than SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS
 *    (`session-snapshot-recovery-budget.ts`).
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
  /**
   * ms epoch of the last clean wake-failure report; null when absent or
   * unparseable. The resumer releases a spent attempt budget only from this
   * timestamp, so the classifier must carry it or it will declare a session
   * dead that the resumer would still wake.
   */
  recoveryFailedAtMs: number | null;
}

export type ResumabilityProbeOutcome = 'ok' | 'error' | 'not_run';

export type SupersessionProbeOutcome = 'ok' | 'error' | 'not_run';

/**
 * How this task's recovery ownership marker relates to it.
 *  - `none`     — no exact wake successor marker exists; this task was never superseded.
 *  - `live`     — a successor exists but has not accepted runtime ownership yet.
 *  - `terminal` — this task WAS superseded and is safe to retire benignly because
 *                 the exact successor is in_progress or later.
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
  /** Optional canonical chat owner used by reconciliation's cross-store fence. */
  expectedChatSessionId?: string | null;
  /** Optional current ACP owner; historical siblings cannot terminalize it. */
  expectedAcpSessionId?: string | null;
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
  /**
   * ProjectData work evidence per active ACP session. Only describes a verdict
   * (`TaskRuntimeLiveness.evidence`); absent means "not read", reported as null.
   */
  workEvidence?: RuntimeWorkEvidenceSnapshot[];
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
   * `SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS` as the resumer resolves it. The
   * ceiling above is a burst budget, so the classifier needs the same decay
   * window or it will call a session dead that the resumer would still wake.
   */
  resumabilityRecoveryAttemptDecayMs: number;
  /**
   * `not_run` preserves the pre-supersession behaviour for callers that cannot
   * reach D1; `error` withholds a conclusive-death verdict because the
   * alternative is failing a task whose conversation is demonstrably alive.
   */
  supersessionProbeOutcome: SupersessionProbeOutcome;
  /** How this task's recovery family relates to it. See `loadTaskSupersession`. */
  supersession: TaskSupersession;
  /**
   * Whether the task's own chat session still holds a restorable or in-flight
   * sleep record. Keyed on `tasks.chat_session_id`, so unlike
   * `sessionResumability` it survives a NULL `tasks.workspace_id`, a NULL
   * `workspaces.chat_session_id`, and a snapshot row whose own `workspace_id` is
   * NULL — the three shapes that made the workspace-scoped probe unreachable for
   * sleeping conversations in production.
   *
   * `not_run` preserves the pre-guard behaviour for callers that cannot reach D1;
   * `unknown` withholds a conclusive-death verdict. See
   * `task-sleep-preservation.ts`.
   */
  taskSessionSleep: TaskSessionSleepOutcome;
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
