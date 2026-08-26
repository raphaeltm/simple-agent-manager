import type { IncidentConfig } from '../platform-feedback-incident-config';
import type {
  IncidentResolutionReferenceInput,
  IncidentResolutionReferences,
} from '../platform-feedback-incident-resolution-references';
import type { IncidentQueueState } from './constants';

export interface IncidentRow {
  signature: string;
  source: string;
  summary: string;
  severity: string;
  first_seen_at: number;
  last_seen_at: number;
  occurrence_count: number;
  evidence_refs: string;
  diagnosis_id: string | null;
  idea_id: string | null;
  failure_count: number;
  last_failure_reason: string | null;
  last_failed_at: number | null;
  rejected_at: number | null;
  queue_state: string;
  queued_at: number | null;
  dispatch_lease_token: string | null;
  dispatch_lease_expires_at: number | null;
  dispatched_trigger_id: string | null;
  dispatched_execution_id: string | null;
  dispatched_task_id: string | null;
  dispatched_at: number | null;
  dispatch_attempts: number;
  incident_claim_token: string | null;
  incident_claim_expires_at: number | null;
  incident_claimed_by_task_id: string | null;
  incident_claimed_at: number | null;
  resolved_at: number | null;
  resolved_by_task_id: string | null;
  resolved_task_output_pr_url?: string | null;
  resolution_note: string | null;
  resolution_references: string | null;
  expired_at: number | null;
  created_at: string;
  updated_at: string;
}

export interface ResolveIncidentOptions {
  now?: number;
  config?: IncidentConfig;
  resolutionReferences?: IncidentResolutionReferenceInput;
}

export interface IncidentListItem {
  id: string;
  source: string;
  summary: string;
  severity: string;
  queueState: IncidentQueueState;
  firstSeenAt: number;
  lastSeenAt: number;
  queuedAt: number | null;
  occurrenceCount: number;
  dispatchAttempts: number;
  dispatchedTaskId: string | null;
  dispatchedExecutionId: string | null;
  dispatchedTriggerId: string | null;
  dispatchLeaseExpiresAt: number | null;
  claimedByTaskId: string | null;
  claimExpiresAt: number | null;
  rejectedAt: number | null;
  resolvedAt: number | null;
  expiredAt: number | null;
  lastFailureReason: string | null;
  resolutionReferences: IncidentResolutionReferences;
}

export interface IncidentDetail extends IncidentListItem {
  diagnosisId: string | null;
  ideaId: string | null;
  evidence: string;
}

export interface IncidentBacklogSummary {
  pendingCount: number;
  totalOccurrenceCount: number;
  incidents: IncidentListItem[];
  rendered: string;
}

export interface BuildIncidentBacklogSummaryOptions {
  expireStale?: boolean;
}

export interface UserReportIncidentInput {
  userId: string;
  feedbackProjectId: string;
  feedbackProjectOwnerId: string;
  title: string;
  description: string;
  authorizedRefs: Record<string, string | undefined>;
  authorizedKeys: string[];
  contentMaxLength: number;
  titleMaxLength?: number;
  descriptionMaxLength?: number;
  authorizedRefMaxLength?: number;
  ideaTitleMaxLength?: number;
  now?: number;
}

export interface IncidentReopenEvidence {
  timestamp: number;
  nodeAgentVersion?: string | null;
}

export interface IncidentReopenCheckInput {
  queueState: string | null | undefined;
  rejectedAt?: number | null;
  resolvedAt?: number | null;
  expiredAt?: number | null;
  source?: string | null;
  resolutionNote?: string | null;
  resolvedTaskOutputPrUrl?: string | null;
  resolutionReferences?: IncidentResolutionReferences | null;
  occurrence: IncidentReopenEvidence;
  config: Pick<IncidentConfig, 'reopenCooldownMs'>;
  requiredVmAgentVersion?: string | null;
}
