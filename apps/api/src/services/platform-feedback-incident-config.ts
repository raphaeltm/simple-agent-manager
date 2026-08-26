import {
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_AGENT_LEASE_TTL_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_AUTO_TRIGGER_ENABLED,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_MAX_BYTES,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_REF_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_RESOLUTION_NOTE_MAX_LENGTH,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_NAME,
  DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { ENV_KEYS, resolveSetting, SETTING_KEYS } from './platform-config-store';

export interface IncidentConfig {
  autoTriggerEnabled: boolean;
  dispatchLeaseTtlMs: number;
  agentLeaseTtlMs: number;
  maxDispatchAttempts: number;
  maxAgeMs: number;
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

function booleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function getIncidentConfig(env: Env): IncidentConfig {
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
    maxAgeMs: positive(
      env.PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS,
      DEFAULT_PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS
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
