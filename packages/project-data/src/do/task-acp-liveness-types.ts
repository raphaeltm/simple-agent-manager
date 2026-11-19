/**
 * ACP liveness signals ProjectData reports for one task: its ACP sessions and the
 * work evidence each one holds. Owned here because they describe this object's
 * storage; the worker's task-runtime classifier consumes them.
 */
import type { AcpSessionStatus } from '@simple-agent-manager/shared';

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
