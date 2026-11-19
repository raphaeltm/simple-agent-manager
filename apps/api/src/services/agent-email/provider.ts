// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path.
export {
  agentEmailSenderFor,
  createSmtpAgentEmailSender,
  type EmailTransport,
  type EmailTransportEnv,
  type EmailTransportKind,
  emailTransportKind,
  type OutboundAgentEmail,
  systemEmailTransportFor,
} from '@simple-agent-manager/agent-email/definitions';
