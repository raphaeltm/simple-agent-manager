/**
 * The evidence behind a task-runtime verdict, as ages a reader can act on.
 *
 * A verdict alone says WHETHER a runtime counts as live. It does not say whether
 * the agent is working or merely alive and waiting for the user, which is the
 * question an investigator asks first. On 2026-10-04 a parent agent read
 * "VM agent heartbeat is recent" on tasks that had been idle for hours and
 * concluded recovery was heartbeat-only. The real basis was the task's own ACP
 * session heartbeat (`task_acp_session_live`) on an idle conversation, and
 * nothing recorded that.
 *
 * Everything here describes a verdict and never feeds one: the classifier's
 * decisions do not read `TaskRuntimeLiveness.evidence`. No prompt or message
 * content is carried, only state labels and timestamps.
 */
import type {
  RuntimeAcpSessionSnapshot,
  TaskRuntimeLiveness,
  TaskRuntimeLivenessEvidence,
  TaskRuntimeLivenessSignals,
} from './task-runtime-liveness-types';

/**
 * The freshest liveness timestamp an ACP session carries. The classifier's
 * heartbeat freshness test and the reported heartbeat age both read this, so
 * the age shown is the one the verdict was judged on.
 */
export function acpSessionHeartbeatAt(session: RuntimeAcpSessionSnapshot): number {
  return session.lastHeartbeatAt ?? session.updatedAt ?? session.startedAt ?? session.createdAt;
}

function ageMs(nowMs: number, at: number | null | undefined): number | null {
  if (at === null || at === undefined || !Number.isFinite(at)) return null;
  return Math.max(0, nowMs - at);
}

/**
 * Evidence for a verdict that names `acpSessionId`. Both the ACP session and its
 * work evidence are matched by that exact id, so a sibling session's state can
 * never be reported against this verdict.
 */
export function describeTaskRuntimeLivenessEvidence(
  signals: Pick<TaskRuntimeLivenessSignals, 'acpSessions' | 'workEvidence' | 'nowMs'>,
  acpSessionId: string
): TaskRuntimeLivenessEvidence {
  const session = signals.acpSessions.find((candidate) => candidate.id === acpSessionId);
  const work = signals.workEvidence?.find((candidate) => candidate.acpSessionId === acpSessionId);
  return {
    workState: work?.state ?? null,
    activity: work?.activity ?? null,
    lastActivityAgeMs: ageMs(signals.nowMs, work?.activityAt),
    promptStartedAgeMs: ageMs(signals.nowMs, work?.promptStartedAt),
    runtimeWorkProgressAgeMs: ageMs(signals.nowMs, work?.runtimeWorkProgressAt),
    acpHeartbeatAgeMs: session ? ageMs(signals.nowMs, acpSessionHeartbeatAt(session)) : null,
  };
}

/** Flat log fields for a verdict, shared by both liveness adapters (`.claude/rules/61`). */
export function livenessEvidenceLogFields(
  liveness: TaskRuntimeLiveness
): Record<string, string | number | null> {
  const evidence = liveness.evidence;
  return {
    livenessReason: liveness.reason,
    workState: evidence?.workState ?? null,
    activity: evidence?.activity ?? null,
    lastActivityAgeMs: evidence?.lastActivityAgeMs ?? null,
    promptStartedAgeMs: evidence?.promptStartedAgeMs ?? null,
    runtimeWorkProgressAgeMs: evidence?.runtimeWorkProgressAgeMs ?? null,
    acpHeartbeatAgeMs: evidence?.acpHeartbeatAgeMs ?? null,
  };
}
