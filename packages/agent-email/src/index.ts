/**
 * Public entry of agent-email: inbound delivery, replies, setup and recovery of per-trigger
 * email addresses. Functions that need the rest of the worker take an `AgentEmailPorts`.
 */
export {
  agentEmailAddress,
  agentEmailDomain,
  type AgentEmailRecipient,
  generateAddressKey,
  LOOPBACK_DETAIL,
  loopbackAddress,
  normalizeMailbox,
  parseAgentEmailRecipient,
} from './address';
export {
  CloudflareEmailApiError,
  createRoutingRule,
  type DnsRecordView,
  type EmailReadOptions,
  enableSubaddressing,
  enableSubdomainRouting,
  getRoutingSettings,
  getZoneName,
  listDnsRecords,
  listRoutingRules,
  listSendingSubdomains,
  type RoutingRuleInput,
  type RoutingRuleView,
  updateRoutingRule,
  writeRoutingSpf,
} from './cloudflare-email-api';
export {
  buildEmailContext,
  type BuildEmailContextInput,
  renderEmailPrompt,
  sampleEmailContext,
} from './context';
export { type AgentEmailEnv } from './env';
export {
  isValidMessageId,
  MAX_HEADER_VALUE_BYTES,
  MAX_REFERENCES,
  MAX_SUBJECT_LENGTH,
  parseMessageIdList,
  parseSingleMessageId,
  replyReferences,
  replySubject,
  sanitizeDisplayName,
  sanitizeHeaderText,
  sanitizeSubject,
} from './headers';
export {
  handleInboundAgentEmail,
  type InboundDeps,
  type InboundEmailMessage,
  type InboundOutcome,
} from './inbound';
export {
  acceptDelivery,
  type ClaimedDelivery,
  claimForRetry,
  type ClosedDelivery,
  closeDelivery,
  closeExhausted,
  dueDeliveries,
  heldBy,
  type IntakeResult,
  type IntakeValues,
  ownsLease,
  recordIntake,
  retryDelayMs,
  scheduleRetry,
  type StoredInboundEmail,
} from './inbound-delivery';
export {
  type InboundAgentEmail,
  type InboundAttachmentSummary,
  type InboundEnvelope,
  parseInboundEmail,
} from './inbound-message';
export {
  attemptDelivery,
  type AttemptOptions,
  type DeliveryContext,
  type DeliveryOutcome,
} from './inbound-process';
export {
  LOOPBACK_BODY,
  LOOPBACK_SUBJECT,
  type LoopbackReceived,
  type LoopbackSent,
  type LoopbackStatus,
  readLoopbackStatus,
  recordLoopbackReceipt,
  sendLoopbackTest,
} from './loopback';
export {
  type AgentEmailPorts,
  type AgentEmailTriggerAdmissionInput,
  type AgentEmailTriggerAdmissionResult,
  type CloudflareApiPort,
} from './ports';
export {
  type AgentEmailSender,
  agentEmailSenderFor,
  createCloudflareAgentEmailSender,
  type OutboundAgentEmail,
} from './provider';
export { type AgentEmailRecoveryStats, runAgentEmailRecovery } from './recovery';
export {
  AgentEmailReplyError,
  type AgentEmailReplyErrorCode,
  type AgentEmailReplyInput,
  type AgentEmailReplyResult,
  replyToTriggerEmail,
} from './reply';
export {
  AGENT_EMAIL_SETTINGS,
  type AgentEmailSettingName,
  DEFAULT_AGENT_EMAIL_INBOUND_PER_TRIGGER_PER_HOUR,
  DEFAULT_AGENT_EMAIL_LOOPBACK_PER_HOUR,
  DEFAULT_AGENT_EMAIL_MAX_DELIVERY_ATTEMPTS,
  DEFAULT_AGENT_EMAIL_PROCESSING_LEASE_SECONDS,
  DEFAULT_AGENT_EMAIL_READ_TIMEOUT_MS,
  DEFAULT_AGENT_EMAIL_RECOVERY_BATCH_SIZE,
  DEFAULT_AGENT_EMAIL_RETRY_BASE_SECONDS,
  DEFAULT_AGENT_EMAIL_RETRY_MAX_SECONDS,
  DEFAULT_AGENT_EMAIL_SETUP_PLAN_TIMEOUT_MS,
  DEFAULT_AGENT_EMAIL_SETUP_RUNS_PER_HOUR,
  DEFAULT_AGENT_EMAIL_SIGN_IN_CODE_ATTEMPTS_PER_EMAIL_PER_HOUR,
  DEFAULT_AGENT_EMAIL_SIGN_IN_CODES_PER_EMAIL_PER_HOUR,
  DEFAULT_AGENT_EMAIL_SIGN_IN_CODES_PER_IP_PER_HOUR,
} from './setting-definitions';
export { type AgentEmailLimits, getAgentEmailLimits } from './settings';
export { planAgentEmailSetup, runAgentEmailSetup } from './setup';
export {
  allowedAdditions,
  CLOUDFLARE_ROUTING_DKIM_SELECTOR,
  CLOUDFLARE_ROUTING_SPF,
  consentTokenFor,
  describeChange,
  describeChanges,
  differencesFromBaseline,
  firstRoutingRecords,
  subaddressingChange,
  toMailRecord,
} from './setup-changes';
export { AgentEmailMainDomainChangedError, AgentEmailSetupRefusedError } from './setup-errors';
export { type SetupClaim, SetupLease } from './setup-lease';
export { AGENT_EMAIL_RULE_NAME, ensureRoutingRule } from './setup-routing-rule';
export { planRoutingSpf } from './setup-spf';
export { readPublicSpf, verifySpfLookupBudget } from './setup-spf-lookups';
export {
  activeAgentEmailSender,
  AGENT_EMAIL_SETUP_KEY,
  agentEmailConfig,
  type AgentEmailMailRecord,
  type AgentEmailSetupAttempt,
  type AgentEmailSetupRecord,
  claimSetupAttempt,
  completeAgentEmailSetup,
  hasAgentEmailBinding,
  isAgentEmailOn,
  readAgentEmailSetup,
  readSetupAttempt,
  replaceSetupAttempt,
  type StoredSetupAttempt,
} from './setup-state';
export {
  loadEmailTriggerConfig,
  parseAllowedSenders,
  requireAgentEmailOn,
  resolveAllowedSenders,
  toEmailTriggerConfig,
} from './trigger-config';
