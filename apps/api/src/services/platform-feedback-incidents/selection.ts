import type {
  IncidentConfig,
  IncidentDispatchSeverity,
} from '../platform-feedback-incident-config';
import { TERMINAL_TASK_STATUS_SQL } from './constants';

export const INCIDENT_SEVERITY_RANK_SQL = "CASE severity WHEN 'warn' THEN 1 ELSE 2 END";

export const OPEN_TRACKED_WORK_SQL = `(
  (
    idea_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM tasks linked_task
      WHERE linked_task.id = platform_feedback_triages.idea_id
        AND linked_task.status NOT IN (${TERMINAL_TASK_STATUS_SQL})
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
