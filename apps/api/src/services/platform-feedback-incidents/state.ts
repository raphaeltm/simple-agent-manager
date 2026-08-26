import { isNodeAgentVersionCompatible } from '../node-agent-compatibility';
import { parseStoredIncidentResolutionReferences } from '../platform-feedback-incident-resolution-references';
import type { IncidentQueueState } from './constants';
import {
  ACTIVE_INCIDENT_STATES,
  FIX_REFERENCE_PATTERN,
  INCIDENT_QUEUE_STATES,
  TERMINAL_INCIDENT_STATES,
} from './constants';
import type { IncidentListItem, IncidentReopenCheckInput, IncidentRow } from './types';

export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function toQueueState(value: string): IncidentQueueState {
  return INCIDENT_QUEUE_STATES.includes(value as IncidentQueueState)
    ? (value as IncidentQueueState)
    : 'pending';
}

function hasFixReference(
  input: Pick<
    IncidentReopenCheckInput,
    'resolutionNote' | 'resolvedTaskOutputPrUrl' | 'resolutionReferences'
  >
): boolean {
  if (
    input.resolutionReferences?.fixPrUrl ||
    input.resolutionReferences?.dispatchedTaskId ||
    input.resolutionReferences?.linkedRecordId
  ) {
    return true;
  }
  if (input.resolvedTaskOutputPrUrl?.trim()) return true;
  return FIX_REFERENCE_PATTERN.test(input.resolutionNote ?? '');
}

function terminalTimestampForState(
  queueState: IncidentQueueState,
  input: Pick<IncidentReopenCheckInput, 'resolvedAt' | 'expiredAt'>
): number | null {
  if (queueState === 'resolved') return input.resolvedAt ?? null;
  if (queueState === 'expired') return input.expiredAt ?? input.resolvedAt ?? null;
  return null;
}

export function shouldReopenIncidentForOccurrence(input: IncidentReopenCheckInput): boolean {
  if (!Number.isFinite(input.occurrence.timestamp)) return false;

  const queueState = toQueueState(input.queueState ?? 'pending');
  if (input.rejectedAt !== null && input.rejectedAt !== undefined) return false;
  if (queueState === 'rejected') return false;
  if (!TERMINAL_INCIDENT_STATES.has(queueState)) return true;

  const terminalAt = terminalTimestampForState(queueState, input);
  if (terminalAt !== null) {
    if (input.occurrence.timestamp <= terminalAt) return false;
    const cooldownMs = Math.max(0, input.config.reopenCooldownMs);
    if (input.occurrence.timestamp < terminalAt + cooldownMs) return false;
  }

  const source = input.source?.trim().toLowerCase();
  if (source === 'vm-agent' && hasFixReference(input)) {
    const requiredAgentVersion = input.requiredVmAgentVersion?.trim();
    if (
      requiredAgentVersion &&
      !isNodeAgentVersionCompatible(input.occurrence.nodeAgentVersion, requiredAgentVersion)
    ) {
      return false;
    }
  }

  return true;
}

export function toListItem(row: IncidentRow): IncidentListItem {
  return {
    id: row.signature,
    source: row.source,
    summary: row.summary,
    severity: row.severity === 'warn' ? 'warn' : 'error',
    queueState: toQueueState(row.queue_state),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    queuedAt: row.queued_at,
    occurrenceCount: row.occurrence_count,
    dispatchAttempts: row.dispatch_attempts,
    dispatchedTaskId: row.dispatched_task_id,
    dispatchedExecutionId: row.dispatched_execution_id,
    dispatchedTriggerId: row.dispatched_trigger_id,
    dispatchLeaseExpiresAt: row.dispatch_lease_expires_at,
    claimedByTaskId: row.incident_claimed_by_task_id,
    claimExpiresAt: row.incident_claim_expires_at,
    rejectedAt: row.rejected_at,
    resolvedAt: row.resolved_at,
    expiredAt: row.expired_at,
    lastFailureReason: row.last_failure_reason,
    resolutionReferences: parseStoredIncidentResolutionReferences(row.resolution_references),
  };
}

export function isActiveIncidentState(state: string): boolean {
  return ACTIVE_INCIDENT_STATES.has(toQueueState(state));
}

export function isTerminalIncidentState(state: string): boolean {
  return TERMINAL_INCIDENT_STATES.has(toQueueState(state));
}
