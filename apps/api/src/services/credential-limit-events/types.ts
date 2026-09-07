import type { ProjectEventAdmissionOutcome } from '@simple-agent-manager/shared';
import {
  CREDENTIAL_LIMIT_EVENT_SOURCE,
  CREDENTIAL_LIMIT_EVENT_TYPES,
} from '@simple-agent-manager/shared';

export { CREDENTIAL_LIMIT_EVENT_SOURCE, CREDENTIAL_LIMIT_EVENT_TYPES };

export type CredentialSource = 'user' | 'project' | 'platform';
export type CredentialLimitStatus = 'allowed' | 'allowed_warning' | 'rejected' | 'unknown';
export type CredentialLimitLevel = 'ok' | 'warning' | 'critical' | 'rejected';
export type CredentialLimitTransition = keyof typeof CREDENTIAL_LIMIT_EVENT_TYPES;
export type CredentialLimitAdmissionOutcome =
  | 'created'
  | 'duplicate_replay'
  | 'conflict'
  | 'capacity';
export type CredentialLimitDispatchOutcome =
  | ProjectEventAdmissionOutcome
  | 'capacity'
  | 'failed'
  | 'superseded'
  | 'deferred';

export type CredentialLimitObservation = {
  projectId: string;
  userId: string;
  credentialReference: string;
  credentialSource: CredentialSource | string;
  provider: string;
  providerMode: string;
  windowType: string;
  source: string;
  observedAt: number;
  status?: CredentialLimitStatus;
  agentType?: string | null;
  workspaceId?: string | null;
  agentSessionId?: string | null;
  chatSessionId?: string | null;
  utilizationPercent?: number | null;
  limitAmount?: number | null;
  remainingAmount?: number | null;
  windowMinutes?: number | null;
  resetsAt?: number | null;
  freshnessMs?: number | null;
};

export type CredentialLimitObservationIgnoreReason =
  | 'invalid'
  | 'unsupported'
  | 'too_old'
  | 'future'
  | 'stale'
  | 'duplicate'
  | 'ok'
  | 'capacity';

export type CredentialLimitObservationResult =
  | { outcome: 'ignored'; reason: CredentialLimitObservationIgnoreReason }
  | {
      outcome: 'event_admitted';
      transition: CredentialLimitTransition;
      eventType: string;
      deliveryKey: string;
      admissionId: string;
      admissionOutcome: CredentialLimitAdmissionOutcome;
      dispatchOutcome: CredentialLimitDispatchOutcome;
    };

export type CredentialLimitWindowRow = {
  status: CredentialLimitStatus;
  last_event_level: CredentialLimitLevel;
  utilization_percent: number | null;
  limit_amount: number | null;
  remaining_amount: number | null;
  window_minutes: number | null;
  resets_at: number | null;
  observed_at: number;
  stale_sample_count: number;
  duplicate_sample_count: number;
  last_event_delivery_key: string | null;
};

export type CredentialLimitThresholds = {
  warningPercent: number;
  criticalPercent: number;
};

export type CredentialLimitRuntimeConfig = CredentialLimitThresholds & {
  maxObservationsPerReport: number;
  observationMaxAgeMs: number;
  observationFutureSkewMs: number;
  resetMaxFutureMs: number;
  supportedProviders: ReadonlySet<string>;
  supportedSources: ReadonlySet<string>;
  supportedWindowTypes: ReadonlySet<string>;
  admissionMaxActivePerProject: number;
  admissionRetryBatchSize: number;
  admissionMaxAttempts: number;
  admissionRetryDelayMs: number;
  admissionRetentionDays: number;
};

export type SanitizedCredentialLimitObservation = CredentialLimitObservation & {
  projectId: string;
  userId: string;
  credentialReference: string;
  credentialSource: CredentialSource;
  provider: string;
  providerMode: string;
  windowType: string;
  source: string;
  observedAt: number;
  status: CredentialLimitStatus;
  agentType: string | null;
  workspaceId: string | null;
  agentSessionId: string | null;
  chatSessionId: string | null;
  utilizationPercent: number | null;
  limitAmount: number | null;
  remainingAmount: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
  freshnessMs: number;
  serverReceivedAt: number;
};

export type ProxyCredentialLimitContext = {
  projectId?: string | null;
  userId?: string | null;
  credentialReference?: string | null;
  credentialSource?: CredentialSource | string | null;
  provider: 'anthropic' | 'openai';
  providerMode: string;
  source: string;
  responseStatus?: number;
  agentType?: string | null;
  workspaceId?: string | null;
  agentSessionId?: string | null;
  chatSessionId?: string | null;
  observedAt?: number;
};
