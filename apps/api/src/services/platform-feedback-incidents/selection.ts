import type {
  IncidentConfig,
  IncidentDispatchSeverity,
} from '../platform-feedback-incident-config';
import { TERMINAL_TASK_STATUS_SQL } from './constants';
import { pipelineOwnsIdeaSql } from './idea-ownership';

export const INCIDENT_SEVERITY_RANK_SQL = "CASE severity WHEN 'warn' THEN 1 ELSE 2 END";

/**
 * An incident is excluded from dispatch while work on it is tracked elsewhere: an open idea a
 * person or agent took up, a diagnosis promoted to an idea, or an open task cited as its fix.
 *
 * The incident's own idea counts only once someone has engaged with it. While the pipeline
 * still owns it (`pipelineOwnsIdeaSql`, see `idea-ownership.ts`) it is a record of the
 * signature, not tracked work; counting it made every incident exclude itself (idea
 * 01M2CKJMNNE0FGASV18J0GFRAT).
 *
 * Consumers, which must keep agreeing: `listDispatchableIncidentQueue`,
 * `hasDispatchablePendingIncidents` (queries.ts), `reserveIncidentDispatch` (dispatch.ts) and
 * the decline breakdown (`explainUndispatchableIncidents`).
 */
export const OPEN_TRACKED_WORK_SQL = `(
  (
    idea_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM tasks linked_task
      WHERE linked_task.id = platform_feedback_triages.idea_id
        AND linked_task.status NOT IN (${TERMINAL_TASK_STATUS_SQL})
        AND NOT ${pipelineOwnsIdeaSql('platform_feedback_triages', 'linked_task')}
    )
  )
  OR (
    diagnosis_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM debug_diagnoses linked_diagnosis
      JOIN tasks linked_task ON linked_task.id = linked_diagnosis.idea_id
      WHERE linked_diagnosis.id = platform_feedback_triages.diagnosis_id
        AND linked_task.status NOT IN (${TERMINAL_TASK_STATUS_SQL})
    )
  )
  OR (
    resolved_by_task_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM tasks linked_task
      WHERE linked_task.id = platform_feedback_triages.resolved_by_task_id
        AND linked_task.status NOT IN (${TERMINAL_TASK_STATUS_SQL})
    )
  )
)`;

export function dispatchSeverityRank(severity: IncidentDispatchSeverity): number {
  return severity === 'warn' ? 1 : 2;
}

export function staleSingletonBefore(
  now: number,
  config: Pick<IncidentConfig, 'staleSingletonMaxAgeMs'>
): number {
  return now - config.staleSingletonMaxAgeMs;
}
