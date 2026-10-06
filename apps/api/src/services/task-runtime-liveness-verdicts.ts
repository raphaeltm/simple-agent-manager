/**
 * Verdict builders shared by the task-runtime classifier: the conclusive-death
 * path and the sleep and supersession escapes that must pre-empt it.
 *
 * Split out of `task-runtime-liveness.ts` to keep that module under the 500-line
 * ceiling (`.claude/rules/18`). Re-exported from `task-runtime-liveness.ts` so
 * existing imports are unchanged.
 */
import type {
  RuntimeWorkspaceSnapshot,
  TaskRuntimeLiveness,
  TaskRuntimeLivenessSignals,
} from './task-runtime-liveness-types';

/**
 * Reason suffix marking a conclusive verdict that is a *supersession* rather
 * than a runtime death. Terminal writers key on this to record the benign
 * cancellation status instead of `failed`.
 */
export const SUPERSEDED_TERMINAL_REASON_SUFFIX = '_superseded_by_completed_wake';

/** True when a conclusive verdict was reached because the wake moved on. */
export function isSupersededTerminalReason(reason: string): boolean {
  return reason.endsWith(SUPERSEDED_TERMINAL_REASON_SUFFIX);
}

/**
 * A task whose conversation has been handed to a live successor is superseded,
 * not dead. Returns the inconclusive verdict that must pre-empt any
 * conclusive-death return, or null when supersession cannot explain the state.
 *
 * This is the `.claude/rules/58` pairing for task lineage: the resumer
 * (`claimSessionSnapshotRecovery` via `sourceTaskGuardCondition`) requires the
 * source task to be NON-terminal, so failing a superseded predecessor does not
 * merely mislabel it — it permanently revokes the guarded/parent wake path for
 * that conversation.
 */
function supersessionVerdict(
  signals: TaskRuntimeLivenessSignals,
  workspace: RuntimeWorkspaceSnapshot | null,
  reasonPrefix: string
): TaskRuntimeLiveness | null {
  if (signals.supersessionProbeOutcome === 'error') {
    return livenessResult(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_supersession_unknown`,
      activeAcpSessionId: null,
    });
  }
  if (signals.supersession === 'live') {
    return livenessResult(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_superseded_by_live_wake`,
      activeAcpSessionId: null,
    });
  }
  if (signals.supersession === 'terminal') {
    // Bounded escape (`.claude/rules/47`): the conversation is over, so the task
    // must leave the candidate set. But it ended by supersession, not runtime
    // death, so the verdict carries the marker that makes terminal writers record
    // a benign cancellation instead of a failure.
    //
    // Safe with respect to the wake path: a superseded predecessor always has a
    // NULL `chat_session_id` (the handoff's stmt 2 clears it), and `terminal`
    // means no live recovery owner exists — so both branches of
    // `sourceTaskGuardCondition`'s OR are already false and the guarded wake was
    // failing for this task regardless of its status.
    return livenessResult(workspace, {
      live: false,
      conclusive: true,
      reason: `${reasonPrefix}${SUPERSEDED_TERMINAL_REASON_SUFFIX}`,
      activeAcpSessionId: null,
    });
  }
  return null;
}

/**
 * A conversation that is asleep, or on its way to sleep, is not dead — even when
 * every workspace/node signal says it is, because sleeping is exactly what
 * deletes those rows.
 *
 * This is the `.claude/rules/58` pairing for the sleep lifecycle, and it is keyed
 * on the TASK's `chat_session_id` rather than the workspace's, so it still fires
 * for the three shapes that make `sessionResumability` unreachable: a NULL
 * `tasks.workspace_id`, a NULL `workspaces.chat_session_id` after a wake handoff,
 * and a snapshot row whose own `workspace_id` is NULL. The adapters resolve it
 * through `loadTaskSleepPreservation`, which reuses the resumer's own
 * `restorableOrInFlightSleepSnapshotPredicateSql` verbatim.
 *
 * Returns the inconclusive verdict that must pre-empt a conclusive-death return,
 * or null when sleep cannot explain the state. Both outcomes are bounded — see
 * `loadTaskSleepPreservation` — so this can never make a task immortal.
 */
function sessionSleepVerdict(
  signals: TaskRuntimeLivenessSignals,
  workspace: RuntimeWorkspaceSnapshot | null,
  reasonPrefix: string
): TaskRuntimeLiveness | null {
  if (signals.taskSessionSleep === 'unknown') {
    return livenessResult(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_session_sleep_unknown`,
      activeAcpSessionId: null,
    });
  }
  if (signals.taskSessionSleep === 'preserve') {
    return livenessResult(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_session_sleeping`,
      activeAcpSessionId: null,
    });
  }
  return null;
}

/**
 * The ONE way to build a conclusive "this runtime is dead" verdict.
 *
 * Routing every such return through here is what makes the sleep escape hold by
 * construction: the first cut of this fix guarded only `workspace_missing` and
 * `workspace_<status>`, leaving `node_not_live`, `cf_container_<terminal>` and
 * `task_acp_session_terminal` unguarded — all three reachable while
 * `workspaces.status` still reads `running`, which is precisely the window
 * between a node being destroyed for sleep and the workspace row catching up
 * (the five-minute gap in the `.claude/rules/58` incident). Production carried
 * that shape: `node_not_live` with a `scheduled` snapshot, twice in 30 days.
 *
 * The SUPERSESSION half is deliberately inert at those same three sites, and that
 * is not an oversight: they sit downstream of the `workspace.status !== 'running'`
 * early return, while `needsTaskSupersessionProbe` fires only for the opposite
 * condition — so `signals.supersession` is always its `'none'` default there.
 * Nor could a real superseded task reach them: the wake handoff nulls
 * `workspaces.chat_session_id`, so it exits earlier and inconclusively at
 * `workspace_runtime_identity_incomplete`. It is kept uniform here as
 * defence-in-depth against that invariant changing; do not spend time trying to
 * write a test that proves it discriminating at those three sites.
 */
export function conclusiveDeath(
  signals: TaskRuntimeLivenessSignals,
  workspace: RuntimeWorkspaceSnapshot | null,
  reason: string,
  activeAcpSessionId: string | null = null
): TaskRuntimeLiveness {
  return (
    sessionSleepVerdict(signals, workspace, reason) ??
    supersessionVerdict(signals, workspace, reason) ??
    livenessResult(workspace, { live: false, conclusive: true, reason, activeAcpSessionId })
  );
}

/**
 * Whether a conclusive-death verdict was reached without the task-scoped sleep
 * signal ever being loaded. Adapters use this to pay for the lookup only for a
 * candidate they are otherwise about to terminalize (`.claude/rules/47`,
 * `.claude/rules/58` requirement 6) — the same classify → probe → re-classify
 * shape as `needsNodeHealthProbe`.
 *
 * It fires precisely on the three conclusive-death paths reachable while
 * `workspaces.status` still reads `running` — `node_not_live`,
 * `cf_container_<terminal>` and `task_acp_session_terminal` — because
 * `needsTaskSupersessionProbe` and `needsSessionResumabilityProbe` both decline
 * for a running workspace, leaving both escapes unpopulated there.
 */
export function needsDeferredSessionSleepProbe(
  liveness: TaskRuntimeLiveness,
  signals: TaskRuntimeLivenessSignals
): boolean {
  if (signals.taskSessionSleep !== 'not_run') return false;
  if (!liveness.conclusive || liveness.live) return false;
  // A supersession is already a benign, correctly-labelled ending; re-probing
  // would only preserve a task whose conversation demonstrably moved on.
  return !isSupersededTerminalReason(liveness.reason);
}

export function livenessResult(
  workspace: RuntimeWorkspaceSnapshot | null,
  values: Omit<TaskRuntimeLiveness, 'workspaceStatus' | 'nodeId'>
): TaskRuntimeLiveness {
  return {
    ...values,
    workspaceStatus: workspace?.status ?? null,
    nodeId: workspace?.nodeId ?? null,
    ...(workspace?.nodeId && workspace.userId
      ? { deliveryTarget: { nodeId: workspace.nodeId, userId: workspace.userId } }
      : {}),
  };
}
