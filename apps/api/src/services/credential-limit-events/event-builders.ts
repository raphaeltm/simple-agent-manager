import type {
  AdmitProjectEventInput,
  ProjectEventJsonValue,
  ProjectEventMetadata,
  ProjectEventSeverity,
} from '@simple-agent-manager/shared';

import {
  CREDENTIAL_LIMIT_EVENT_SOURCE,
  CREDENTIAL_LIMIT_EVENT_TYPES,
  type CredentialLimitLevel,
  type CredentialLimitRuntimeConfig,
  type CredentialLimitTransition,
  type SanitizedCredentialLimitObservation,
} from './types';
import {
  boundedIdentifier,
  boundedText,
  DISPLAY_LABEL_MAX_COUNT,
  fingerprint,
  normalizeMetadata,
  sha256Hex,
  stableStringify,
} from './values';

export function levelRank(level: CredentialLimitLevel): number {
  switch (level) {
    case 'ok':
      return 0;
    case 'warning':
      return 1;
    case 'critical':
      return 2;
    case 'rejected':
      return 3;
  }
}

export function computeLevel(
  observation: Pick<SanitizedCredentialLimitObservation, 'status' | 'utilizationPercent'>,
  thresholds: Pick<CredentialLimitRuntimeConfig, 'warningPercent' | 'criticalPercent'>
): CredentialLimitLevel | null {
  if (observation.status === 'rejected') return 'rejected';
  if (
    observation.utilizationPercent !== null &&
    observation.utilizationPercent >= thresholds.criticalPercent
  ) {
    return 'critical';
  }
  if (
    observation.status === 'allowed_warning' ||
    (observation.utilizationPercent !== null &&
      observation.utilizationPercent >= thresholds.warningPercent)
  ) {
    return 'warning';
  }
  if (observation.status === 'allowed' || observation.utilizationPercent !== null) return 'ok';
  return null;
}

export function transitionFromLevels(
  previousLevel: CredentialLimitLevel | null,
  nextLevel: CredentialLimitLevel
): CredentialLimitTransition | null {
  if (previousLevel === nextLevel) return null;
  if (nextLevel === 'ok') return previousLevel && previousLevel !== 'ok' ? 'reset' : null;
  if (previousLevel && levelRank(nextLevel) < levelRank(previousLevel)) {
    return nextLevel === 'warning' ? 'warning' : null;
  }
  return nextLevel;
}

function metadataForObservation(
  observation: SanitizedCredentialLimitObservation,
  transition: CredentialLimitTransition,
  level: CredentialLimitLevel,
  previousLevel: CredentialLimitLevel | null,
  config: Pick<CredentialLimitRuntimeConfig, 'warningPercent' | 'criticalPercent'>
): ProjectEventMetadata {
  const visibilityScope = observation.credentialSource === 'user' ? 'user' : 'project';
  return normalizeMetadata({
    transition,
    level,
    previousLevel: previousLevel ?? undefined,
    provider: observation.provider,
    providerMode: observation.providerMode,
    credentialSource: observation.credentialSource,
    credentialReference: observation.credentialReference,
    visibilityScope,
    affectedUserId: visibilityScope === 'user' ? observation.userId : undefined,
    affectedProjectId: observation.projectId,
    windowType: observation.windowType,
    source: observation.source,
    status: observation.status,
    observedAt: observation.observedAt,
    serverReceivedAt: observation.serverReceivedAt,
    freshnessMs: observation.freshnessMs,
    resetsAt: observation.resetsAt ?? undefined,
    windowMinutes: observation.windowMinutes ?? undefined,
    utilizationPercent: observation.utilizationPercent ?? undefined,
    limitAmount: observation.limitAmount ?? undefined,
    remainingAmount: observation.remainingAmount ?? undefined,
    thresholdWarningPercent: config.warningPercent,
    thresholdCriticalPercent: config.criticalPercent,
    advisoryOnly: true,
    workspaceId: observation.workspaceId ?? undefined,
    agentSessionId: observation.agentSessionId ?? undefined,
    chatSessionId: observation.chatSessionId ?? undefined,
    agentType: observation.agentType ?? undefined,
    admissionVersion: 1,
  });
}

export function severityForTransition(transition: CredentialLimitTransition): ProjectEventSeverity {
  switch (transition) {
    case 'warning':
      return 'warning';
    case 'critical':
    case 'rejected':
      return 'critical';
    case 'reset':
      return 'notice';
  }
}

function displayForObservation(
  observation: SanitizedCredentialLimitObservation,
  transition: CredentialLimitTransition
): AdmitProjectEventInput['display'] {
  const titleByTransition: Record<CredentialLimitTransition, string> = {
    warning: 'Credential limit warning',
    critical: 'Credential limit critical',
    rejected: 'Credential limit rejected request',
    reset: 'Credential limit reset',
  };
  const utilization =
    observation.utilizationPercent === null ? null : `${Math.round(observation.utilizationPercent)}%`;
  const summaryParts = [
    observation.provider,
    observation.windowType,
    utilization ? `utilization ${utilization}` : null,
    observation.resetsAt ? `resets ${new Date(observation.resetsAt).toISOString()}` : null,
  ].filter((part): part is string => Boolean(part));
  const labels = [
    observation.provider,
    observation.windowType,
    observation.credentialSource,
    transition,
  ].slice(0, DISPLAY_LABEL_MAX_COUNT);
  return {
    title: boundedText(titleByTransition[transition]),
    summary: boundedText(summaryParts.join(' · ')),
    labels: labels
      .map((label) => boundedIdentifier(label))
      .filter((label): label is string => Boolean(label)),
  };
}

export async function buildEventInput(
  observation: SanitizedCredentialLimitObservation,
  transition: CredentialLimitTransition,
  level: CredentialLimitLevel,
  previousLevel: CredentialLimitLevel | null,
  config: Pick<CredentialLimitRuntimeConfig, 'warningPercent' | 'criticalPercent'>
): Promise<AdmitProjectEventInput> {
  const eventType = CREDENTIAL_LIMIT_EVENT_TYPES[transition];
  const subject = {
    type: 'credential',
    id: observation.credentialReference,
  };
  const metadata = metadataForObservation(observation, transition, level, previousLevel, config);
  const display = displayForObservation(observation, transition);
  const deliverySeed = stableStringify({
    admissionVersion: 1,
    projectId: observation.projectId,
    credentialReference: observation.credentialReference,
    windowType: observation.windowType,
    previousLevel,
    level,
    transition,
    observedAt: observation.observedAt,
    resetsAt: observation.resetsAt,
    status: observation.status,
    source: observation.source,
  });
  const deliveryKey = `credential-limit:${(await sha256Hex(deliverySeed)).slice(0, 48)}`;
  const severity = severityForTransition(transition);
  return {
    projectId: observation.projectId,
    source: CREDENTIAL_LIMIT_EVENT_SOURCE,
    eventType,
    subject,
    severity,
    deliveryKey,
    payloadFingerprint: await fingerprint({
      source: CREDENTIAL_LIMIT_EVENT_SOURCE,
      eventType,
      subject,
      severity,
      metadata,
      display: (display ?? {}) as ProjectEventJsonValue,
    }),
    metadata,
    display,
    occurredAt: observation.observedAt,
    receivedAt: observation.serverReceivedAt,
  };
}
