/**
 * Light entry of agent-email: definitions and pure helpers with no D1, drizzle or email-parsing
 * dependency, for worker modules (the admin settings registry, trigger and sign-in code) that
 * must not load the whole package.
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
  buildEmailContext,
  type BuildEmailContextInput,
  renderEmailPrompt,
  sampleEmailContext,
} from './context';
export {
  type AgentEmailSender,
  agentEmailSenderFor,
  createCloudflareAgentEmailSender,
  createSmtpAgentEmailSender,
  type EmailTransport,
  type EmailTransportEnv,
  type EmailTransportKind,
  emailTransportKind,
  type OutboundAgentEmail,
  systemEmailTransportFor,
} from './provider';
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
  DEFAULT_AGENT_EMAIL_SMTP_TIMEOUT_MS,
} from './setting-definitions';
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
export {
  sendSmtpMessage,
  type SmtpConnect,
  type SmtpDelivery,
  SmtpError,
  type SmtpSendOptions,
} from './smtp-client';
export {
  DEFAULT_SMTP_IMPLICIT_TLS_PORT,
  DEFAULT_SMTP_STARTTLS_PORT,
  isLoopbackHost,
  isSmtpAddress,
  resolveSmtpConfig,
  SMTP_ADDRESS_PATTERN,
  type SmtpConfig,
  type SmtpConfigResult,
  type SmtpEnv,
  type SmtpTlsMode,
} from './smtp-config';
export { buildSmtpMessage, type BuiltMessage, dotStuff, SmtpMessageError } from './smtp-message';
