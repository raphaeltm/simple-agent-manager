/** Agent email tunables: admin-editable runtime settings with typed code defaults. */
import {
  DEFAULT_AGENT_EMAIL_MAX_ALLOWED_SENDERS,
  DEFAULT_AGENT_EMAIL_MAX_BODY_CHARS,
  DEFAULT_AGENT_EMAIL_MAX_INBOUND_BYTES,
  DEFAULT_AGENT_EMAIL_MAX_REPLIES_PER_RUN,
  DEFAULT_AGENT_EMAIL_MAX_REPLY_CHARS,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { resolveAdminSetting } from '../admin-settings';
import {
  type AdminSettingName,
  DEFAULT_AGENT_EMAIL_INBOUND_PER_TRIGGER_PER_HOUR,
  DEFAULT_AGENT_EMAIL_LOOPBACK_PER_HOUR,
  DEFAULT_AGENT_EMAIL_PROCESSING_LEASE_SECONDS,
} from '../admin-settings-registry';

export interface AgentEmailLimits {
  maxInboundBytes: number;
  maxBodyChars: number;
  maxReplyChars: number;
  maxRepliesPerRun: number;
  maxAllowedSenders: number;
  inboundPerTriggerPerHour: number;
  processingLeaseSeconds: number;
  loopbackPerHour: number;
}

// resolveAdminSetting degrades to the registry default on a store outage; the guard only
// narrows the value's type.
async function integerSetting(env: Env, name: AdminSettingName, fallback: number) {
  const value = await resolveAdminSetting(env, name);
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function getAgentEmailLimits(env: Env): Promise<AgentEmailLimits> {
  const [
    maxInboundBytes,
    maxBodyChars,
    maxReplyChars,
    maxRepliesPerRun,
    maxAllowedSenders,
    inboundPerTriggerPerHour,
    processingLeaseSeconds,
    loopbackPerHour,
  ] = await Promise.all([
    integerSetting(env, 'agentEmail.maxInboundBytes', DEFAULT_AGENT_EMAIL_MAX_INBOUND_BYTES),
    integerSetting(env, 'agentEmail.maxBodyChars', DEFAULT_AGENT_EMAIL_MAX_BODY_CHARS),
    integerSetting(env, 'agentEmail.maxReplyChars', DEFAULT_AGENT_EMAIL_MAX_REPLY_CHARS),
    integerSetting(env, 'agentEmail.maxRepliesPerRun', DEFAULT_AGENT_EMAIL_MAX_REPLIES_PER_RUN),
    integerSetting(env, 'agentEmail.maxAllowedSenders', DEFAULT_AGENT_EMAIL_MAX_ALLOWED_SENDERS),
    integerSetting(
      env,
      'agentEmail.inboundPerTriggerPerHour',
      DEFAULT_AGENT_EMAIL_INBOUND_PER_TRIGGER_PER_HOUR
    ),
    integerSetting(
      env,
      'agentEmail.processingLeaseSeconds',
      DEFAULT_AGENT_EMAIL_PROCESSING_LEASE_SECONDS
    ),
    integerSetting(env, 'agentEmail.loopbackPerHour', DEFAULT_AGENT_EMAIL_LOOPBACK_PER_HOUR),
  ]);
  return {
    maxInboundBytes,
    maxBodyChars,
    maxReplyChars,
    maxRepliesPerRun,
    maxAllowedSenders,
    inboundPerTriggerPerHour,
    processingLeaseSeconds,
    loopbackPerHour,
  };
}
