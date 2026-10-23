/**
 * Agent email runtime settings (the "Email" category in Admin → Settings). The admin settings
 * registry turns each spec into a typed integer definition; `getAgentEmailLimits` reads them.
 */
import {
  DEFAULT_AGENT_EMAIL_MAX_ALLOWED_SENDERS,
  DEFAULT_AGENT_EMAIL_MAX_BODY_CHARS,
  DEFAULT_AGENT_EMAIL_MAX_INBOUND_BYTES,
  DEFAULT_AGENT_EMAIL_MAX_REPLIES_PER_RUN,
  DEFAULT_AGENT_EMAIL_MAX_REPLY_CHARS,
} from '@simple-agent-manager/shared';

/** Inbound emails one email trigger accepts per hour before further mail is rejected. */
export const DEFAULT_AGENT_EMAIL_INBOUND_PER_TRIGGER_PER_HOUR = 20;
/** Seconds one attempt to start an agent from an email owns it before a retry may take over. */
export const DEFAULT_AGENT_EMAIL_PROCESSING_LEASE_SECONDS = 120;
/** Loopback self-test emails one superadmin may send per hour. */
export const DEFAULT_AGENT_EMAIL_LOOPBACK_PER_HOUR = 10;
/** Agent email setup runs one superadmin may start per hour; each run calls Cloudflare. */
export const DEFAULT_AGENT_EMAIL_SETUP_RUNS_PER_HOUR = 10;
/** Attempts SAM makes to start an agent from one accepted email before giving up on it. */
export const DEFAULT_AGENT_EMAIL_MAX_DELIVERY_ATTEMPTS = 5;
/** Seconds before an accepted email's first retry; each later retry waits twice as long. */
export const DEFAULT_AGENT_EMAIL_RETRY_BASE_SECONDS = 60;
/** Longest wait between two retries of one accepted email. */
export const DEFAULT_AGENT_EMAIL_RETRY_MAX_SECONDS = 900;
/** Accepted emails one recovery sweep retries. */
export const DEFAULT_AGENT_EMAIL_RECOVERY_BATCH_SIZE = 10;

export const AGENT_EMAIL_SETTINGS = [
  {
    name: 'agentEmail.maxInboundBytes',
    defaultValue: DEFAULT_AGENT_EMAIL_MAX_INBOUND_BYTES,
    description:
      'Largest email, in bytes, an agent email address accepts. Larger mail is rejected.',
    range: { min: 1_024, max: 25 * 1024 * 1024 },
  },
  {
    name: 'agentEmail.maxBodyChars',
    defaultValue: DEFAULT_AGENT_EMAIL_MAX_BODY_CHARS,
    description: 'Characters of an email body placed into the agent prompt.',
    range: { min: 200, max: 100_000 },
  },
  {
    name: 'agentEmail.maxReplyChars',
    defaultValue: DEFAULT_AGENT_EMAIL_MAX_REPLY_CHARS,
    description: 'Longest reply, in characters, an agent may send.',
    range: { min: 100, max: 200_000 },
  },
  {
    name: 'agentEmail.maxRepliesPerRun',
    defaultValue: DEFAULT_AGENT_EMAIL_MAX_REPLIES_PER_RUN,
    description: 'Replies an agent may send from one email-started run. Failed attempts count.',
    range: { min: 1, max: 50 },
  },
  {
    name: 'agentEmail.maxAllowedSenders',
    defaultValue: DEFAULT_AGENT_EMAIL_MAX_ALLOWED_SENDERS,
    description: 'Allowed senders one email trigger may list.',
    range: { min: 1, max: 200 },
  },
  {
    name: 'agentEmail.inboundPerTriggerPerHour',
    defaultValue: DEFAULT_AGENT_EMAIL_INBOUND_PER_TRIGGER_PER_HOUR,
    description:
      'Emails one email trigger accepts per hour. Further mail is rejected until the hour resets.',
    range: { min: 1, max: 10_000 },
  },
  {
    name: 'agentEmail.processingLeaseSeconds',
    defaultValue: DEFAULT_AGENT_EMAIL_PROCESSING_LEASE_SECONDS,
    description:
      'Seconds one attempt to start an agent from an email owns it before a retry may take over. The retry sweep waits no longer than this for one attempt.',
    range: { min: 10, max: 3_600 },
  },
  {
    name: 'agentEmail.loopbackPerHour',
    defaultValue: DEFAULT_AGENT_EMAIL_LOOPBACK_PER_HOUR,
    description: 'Loopback test emails one superadmin may send per hour.',
    range: { min: 1, max: 100 },
  },
  {
    name: 'agentEmail.setupRunsPerHour',
    defaultValue: DEFAULT_AGENT_EMAIL_SETUP_RUNS_PER_HOUR,
    description:
      'Times one superadmin may run the agent email setup per hour. Each run calls Cloudflare.',
    range: { min: 1, max: 100 },
  },
  {
    name: 'agentEmail.maxDeliveryAttempts',
    defaultValue: DEFAULT_AGENT_EMAIL_MAX_DELIVERY_ATTEMPTS,
    description:
      'Attempts SAM makes to start an agent from one accepted email before giving up on it.',
    range: { min: 1, max: 20 },
  },
  {
    name: 'agentEmail.retryBaseSeconds',
    defaultValue: DEFAULT_AGENT_EMAIL_RETRY_BASE_SECONDS,
    description:
      'Seconds before an accepted email is retried after a failed attempt; each later retry waits twice as long.',
    range: { min: 10, max: 3_600 },
  },
  {
    name: 'agentEmail.retryMaxSeconds',
    defaultValue: DEFAULT_AGENT_EMAIL_RETRY_MAX_SECONDS,
    description: 'Longest wait, in seconds, between two retries of one accepted email.',
    range: { min: 60, max: 86_400 },
  },
  {
    name: 'agentEmail.recoveryBatchSize',
    defaultValue: DEFAULT_AGENT_EMAIL_RECOVERY_BATCH_SIZE,
    description: 'Accepted emails one 5-minute recovery sweep retries.',
    range: { min: 1, max: 100 },
  },
] as const;

export type AgentEmailSettingName = (typeof AGENT_EMAIL_SETTINGS)[number]['name'];
