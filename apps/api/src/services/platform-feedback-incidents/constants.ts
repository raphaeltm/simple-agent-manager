import { TASK_TERMINAL_STATUSES } from '@simple-agent-manager/shared';

export const INCIDENT_QUEUE_STATES = [
  'pending',
  'dispatched',
  'claimed',
  'resolved',
  'rejected',
  'expired',
  // Neither active nor terminal: a genuine defect triage chose to measure rather than fix now.
  // Recurrences only update counts (`watching.ts`); a spike returns it to `pending`, and a quiet
  // period expires it. Every predicate over this column is an allowlist of active or terminal
  // states, so watching is excluded from dispatch, claim, reopen and idea close by construction.
  'watching',
] as const;
export type IncidentQueueState = (typeof INCIDENT_QUEUE_STATES)[number];

export const ACTIVE_INCIDENT_STATES = new Set<IncidentQueueState>([
  'pending',
  'dispatched',
  'claimed',
]);
export const TERMINAL_INCIDENT_STATES = new Set<IncidentQueueState>([
  'resolved',
  'rejected',
  'expired',
]);
export const REPORT_SOURCE = 'user-report';
export const TERMINAL_TASK_STATUS_SQL = TASK_TERMINAL_STATUSES.map((status) => `'${status}'`).join(
  ', '
);
export const FIX_REFERENCE_PATTERN =
  /(?:\bPR\s*#\d+\b|#\d+\b|\bpull\/\d+\b|github\.com\/[^\s]+\/pull\/\d+)/i;
