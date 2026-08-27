import { TASK_TERMINAL_STATUSES } from '@simple-agent-manager/shared';

export const INCIDENT_QUEUE_STATES = [
  'pending',
  'dispatched',
  'claimed',
  'resolved',
  'rejected',
  'expired',
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
