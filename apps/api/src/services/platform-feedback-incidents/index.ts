export type { IncidentConfig } from '../platform-feedback-incident-config';
export {
  configuredFeedbackProjectId,
  getIncidentConfig,
} from '../platform-feedback-incident-config';
export type {
  IncidentResolutionReferenceInput,
  IncidentResolutionReferences,
} from '../platform-feedback-incident-resolution-references';
export { IncidentResolutionValidationError } from '../platform-feedback-incident-resolution-references';
export { claimIncident, reclaimExpiredIncidentClaims, resolveIncident } from './claims';
export type { IncidentQueueState } from './constants';
export { INCIDENT_QUEUE_STATES } from './constants';
export {
  completeIncidentDispatchLink,
  reclaimExpiredIncidentDispatches,
  releaseIncidentDispatch,
  reserveIncidentDispatch,
} from './dispatch';
export { expireStaleIncidents } from './lifecycle';
export { buildIncidentBacklogSummary, getIncidentDetail, listIncidentQueue } from './queries';
export {
  isActiveIncidentState,
  isTerminalIncidentState,
  shouldReopenIncidentForOccurrence,
} from './state';
export { incidentSignature } from './text';
export type {
  IncidentBacklogSummary,
  IncidentDetail,
  IncidentListItem,
  IncidentReopenCheckInput,
  IncidentReopenEvidence,
  UserReportIncidentInput,
} from './types';
export { markIncidentPending, upsertUserReportIncident } from './user-report';
