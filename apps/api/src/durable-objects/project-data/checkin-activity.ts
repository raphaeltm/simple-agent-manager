/**
 * What an expiring SAM check-in (`reconciliation_checkin`) knows about its agent's
 * current turn. One assessment feeds both decisions, so they cannot disagree about
 * which evidence counts: deferring the check-in while the agent is provably
 * working, and — once work reported since the check-in has outlived its hard
 * ceiling — the watchdog's verdict that the turn will not end.
 */
import { activeWorkHardStallMs, reconciliationDeadlineMs } from './reconciliation-thresholds';
import type { Env } from './types';

/**
 * The latest assigned or running ACP session of a chat (on one workspace when
 * given), joined to its activity state.
 */
export function loadLatestActiveAcpActivity(
  sql: SqlStorage,
  scope: { sessionId: string; workspaceId: string | null }
): Record<string, unknown> | null {
  const rows = sql
    .exec(
      `SELECT acp.id AS acp_session_id,
              acp.status AS acp_status,
              ss.activity AS activity,
              ss.activity_at AS activity_at,
              ss.prompt_started_at AS prompt_started_at,
              ss.runtime_work_state AS runtime_work_state,
              ss.runtime_work_updated_at AS runtime_work_updated_at,
              ss.runtime_work_progress_at AS runtime_work_progress_at
       FROM acp_sessions acp
       LEFT JOIN session_state ss ON ss.session_id = acp.id
       WHERE acp.chat_session_id = ?
         AND acp.status IN ('assigned', 'running')
         AND (? IS NULL OR acp.workspace_id = ?)
       ORDER BY COALESCE(acp.started_at, acp.assigned_at, acp.updated_at, acp.created_at) DESC
       LIMIT 1`,
      scope.sessionId,
      scope.workspaceId,
      scope.workspaceId
    )
    .toArray();
  return rows[0] ?? null;
}

export interface ActiveCheckinEvidence {
  evidenceAt: number;
  extendedExpiry: number;
  evidenceKinds: string[];
  promptCeilingAt: number | null;
  runtimeWorkCeilingAt: number | null;
}

export interface CheckinActivityAssessment {
  /** Work reported since the check-in and still inside its hard ceiling: defer. */
  deferral: ActiveCheckinEvidence | null;
  /**
   * Work reported since the check-in whose hard ceiling has passed. A turn whose
   * label says `prompting` but that reported nothing since the check-in is NOT
   * stalled: silence is unproven, and preservation bounds it instead.
   */
  stalledPastCeiling: boolean;
}

function toFreshNumber(value: unknown, floor: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor ? value : null;
}

function toPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function maxFreshEvidence(floor: number, ...values: unknown[]): number | null {
  const freshValues = values
    .map((value) => toFreshNumber(value, floor))
    .filter((value): value is number => value !== null);
  return freshValues.length > 0 ? Math.max(...freshValues) : null;
}

export function assessCheckinActivity(
  env: Env,
  marker: { createdAt: number },
  active: Record<string, unknown> | null,
  now: number
): CheckinActivityAssessment {
  if (!active) return { deferral: null, stalledPastCeiling: false };
  const hardStallMs = activeWorkHardStallMs(env);
  const activityName = typeof active.activity === 'string' ? active.activity : null;
  const runtimeWorkState =
    typeof active.runtime_work_state === 'string' ? active.runtime_work_state : null;
  const evidenceKinds: string[] = [];
  const ceilings: number[] = [];
  let evidenceAt = 0;
  let stalledPastCeiling = false;
  let promptCeilingAt: number | null = null;
  let runtimeWorkCeilingAt: number | null = null;

  if (activityName === 'prompting' || activityName === 'recovering') {
    const activityEvidenceAt = maxFreshEvidence(
      marker.createdAt,
      active.prompt_started_at,
      active.activity_at
    );
    const promptAnchor =
      toPositiveNumber(active.prompt_started_at) ??
      toPositiveNumber(active.activity_at) ??
      activityEvidenceAt;

    if (activityEvidenceAt !== null && promptAnchor !== null) {
      promptCeilingAt = promptAnchor + hardStallMs;
      if (promptCeilingAt > now) {
        evidenceAt = Math.max(evidenceAt, activityEvidenceAt);
        ceilings.push(promptCeilingAt);
        evidenceKinds.push('prompt_activity');
      } else {
        stalledPastCeiling = true;
      }
    }
  }

  if (runtimeWorkState === 'active' || runtimeWorkState === 'settling') {
    const runtimeWorkEvidenceAt = maxFreshEvidence(
      marker.createdAt,
      active.runtime_work_progress_at,
      active.runtime_work_updated_at
    );
    const runtimeWorkAnchor =
      toPositiveNumber(active.runtime_work_progress_at) ??
      toPositiveNumber(active.runtime_work_updated_at) ??
      runtimeWorkEvidenceAt;

    if (runtimeWorkEvidenceAt !== null && runtimeWorkAnchor !== null) {
      runtimeWorkCeilingAt = runtimeWorkAnchor + hardStallMs;
      if (runtimeWorkCeilingAt > now) {
        evidenceAt = Math.max(evidenceAt, runtimeWorkEvidenceAt);
        ceilings.push(runtimeWorkCeilingAt);
        evidenceKinds.push('runtime_work');
      } else {
        stalledPastCeiling = true;
      }
    }
  }

  if (evidenceAt <= 0 || ceilings.length === 0) {
    return { deferral: null, stalledPastCeiling };
  }
  return {
    deferral: {
      evidenceAt,
      extendedExpiry: Math.min(now + reconciliationDeadlineMs(env), ...ceilings),
      evidenceKinds,
      promptCeilingAt,
      runtimeWorkCeilingAt,
    },
    stalledPastCeiling,
  };
}
