import {
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_AGENT_LEASE_TTL_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_AUTO_TRIGGER_ENABLED,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_DISPATCH_RATE_WINDOW_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_MAX_BYTES,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_REF_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCHES_PER_TRIGGER_WINDOW,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_SEVERITY,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_RECLAIM_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_RESOLUTION_NOTE_MAX_LENGTH,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_EXPIRY_BATCH_SIZE,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_NAME,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { ENV_KEYS, resolveSetting, SETTING_KEYS } from './platform-config-store';

export type IncidentDispatchSeverity = 'warn' | 'error';

export interface IncidentConfig {
  autoTriggerEnabled: boolean;
  dispatchLeaseTtlMs: number;
  agentLeaseTtlMs: number;
  maxDispatchAttempts: number;
  reopenCooldownMs: number;
  reclaimLimit: number;
  maxAgeMs: number;
  staleSingletonMaxAgeMs: number;
  staleSingletonExpiryBatchSize: number;
  minDispatchSeverity: IncidentDispatchSeverity;
  minDispatchBatchSize: number;
  minPendingAgeMs: number;
  dispatchRateWindowMs: number;
  maxDispatchesPerTriggerWindow: number;
  triggerLimit: number;
  triggerName: string;
  triggerTemplate: string;
  summaryLimit: number;
  evidenceRefLimit: number;
  evidenceMaxBytes: number;
  resolutionNoteMaxLength: number;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegative(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function dispatchSeveritySetting(
  value: string | undefined,
  fallback: IncidentDispatchSeverity
): IncidentDispatchSeverity {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'warn' || normalized === 'error') return normalized;
  return fallback;
}

export function getIncidentConfig(env: Env): IncidentConfig {
  const maxAgeMs = positive(
    env.PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS,
    DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS
  );
  return {
    autoTriggerEnabled: booleanSetting(
      env.PLATFORM_FEEDBACK_INCIDENT_AUTO_TRIGGER_ENABLED,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_AUTO_TRIGGER_ENABLED
    ),
    dispatchLeaseTtlMs: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS
    ),
    agentLeaseTtlMs: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_AGENT_LEASE_TTL_MS,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_AGENT_LEASE_TTL_MS
    ),
    maxDispatchAttempts: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS
    ),
    reopenCooldownMs: nonNegative(
      env.PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS
    ),
    reclaimLimit: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_RECLAIM_LIMIT,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_RECLAIM_LIMIT
    ),
    maxAgeMs,
    staleSingletonMaxAgeMs: Math.min(
      positive(
        env.PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS,
        DEFAULT_PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS
      ),
      maxAgeMs
    ),
    staleSingletonExpiryBatchSize: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_EXPIRY_BATCH_SIZE,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_EXPIRY_BATCH_SIZE
    ),
    minDispatchSeverity: dispatchSeveritySetting(
      env.PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_SEVERITY,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_SEVERITY
    ),
    minDispatchBatchSize: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE
    ),
    minPendingAgeMs: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS
    ),
    dispatchRateWindowMs: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_DISPATCH_RATE_WINDOW_MS,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_DISPATCH_RATE_WINDOW_MS
    ),
    maxDispatchesPerTriggerWindow: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCHES_PER_TRIGGER_WINDOW,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCHES_PER_TRIGGER_WINDOW
    ),
    triggerLimit: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT
    ),
    triggerName:
      env.PLATFORM_FEEDBACK_INCIDENT_TRIGGER_NAME?.trim() ||
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_NAME,
    triggerTemplate:
      env.PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE?.trim() ||
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE,
    summaryLimit: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT
    ),
    evidenceRefLimit: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_REF_LIMIT,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_REF_LIMIT
    ),
    evidenceMaxBytes: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_MAX_BYTES,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_MAX_BYTES
    ),
    resolutionNoteMaxLength: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_RESOLUTION_NOTE_MAX_LENGTH,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_RESOLUTION_NOTE_MAX_LENGTH
    ),
  };
}

export async function configuredFeedbackProjectId(env: Env): Promise<string | undefined> {
  const setting = await resolveSetting(
    env,
    SETTING_KEYS.feedbackProjectId,
    ENV_KEYS.feedbackProjectId
  );
  const projectId = setting.value?.trim();
  return projectId || undefined;
}
