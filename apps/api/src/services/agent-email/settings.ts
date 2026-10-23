/** Agent email tunables: admin-editable runtime settings with typed code defaults. */
import type { Env } from '../../env';
import { resolveAdminSetting } from '../admin-settings';
import { AGENT_EMAIL_SETTINGS, type AgentEmailSettingName } from './setting-definitions';

export interface AgentEmailLimits {
  maxInboundBytes: number;
  maxBodyChars: number;
  maxReplyChars: number;
  maxRepliesPerRun: number;
  maxAllowedSenders: number;
  inboundPerTriggerPerHour: number;
  processingLeaseSeconds: number;
  loopbackPerHour: number;
  setupRunsPerHour: number;
  maxDeliveryAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  recoveryBatchSize: number;
}

const FIELD_BY_SETTING: Record<AgentEmailSettingName, keyof AgentEmailLimits> = {
  'agentEmail.maxInboundBytes': 'maxInboundBytes',
  'agentEmail.maxBodyChars': 'maxBodyChars',
  'agentEmail.maxReplyChars': 'maxReplyChars',
  'agentEmail.maxRepliesPerRun': 'maxRepliesPerRun',
  'agentEmail.maxAllowedSenders': 'maxAllowedSenders',
  'agentEmail.inboundPerTriggerPerHour': 'inboundPerTriggerPerHour',
  'agentEmail.processingLeaseSeconds': 'processingLeaseSeconds',
  'agentEmail.loopbackPerHour': 'loopbackPerHour',
  'agentEmail.setupRunsPerHour': 'setupRunsPerHour',
  'agentEmail.maxDeliveryAttempts': 'maxDeliveryAttempts',
  'agentEmail.retryBaseSeconds': 'retryBaseSeconds',
  'agentEmail.retryMaxSeconds': 'retryMaxSeconds',
  'agentEmail.recoveryBatchSize': 'recoveryBatchSize',
};

// resolveAdminSetting degrades to the registry default on a store outage; the guard only
// narrows the value's type.
async function integerSetting(env: Env, name: AgentEmailSettingName, fallback: number) {
  const value = await resolveAdminSetting(env, name);
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function getAgentEmailLimits(env: Env): Promise<AgentEmailLimits> {
  const entries = await Promise.all(
    AGENT_EMAIL_SETTINGS.map(
      async (setting) =>
        [
          FIELD_BY_SETTING[setting.name],
          await integerSetting(env, setting.name, setting.defaultValue),
        ] as const
    )
  );
  return Object.fromEntries(entries) as Record<keyof AgentEmailLimits, number>;
}
