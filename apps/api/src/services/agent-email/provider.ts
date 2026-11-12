/**
 * Agent email provider boundary (idea 01KS4Y3NV0Q51T0MQ6XG0GXD16): trigger, session and
 * tool code use these provider-neutral shapes.
 *
 * Two transports implement `AgentEmailSender`:
 * - Cloudflare Email Sending (the `AGENT_EMAIL` binding), the only one agent email uses;
 * - SMTP (`SMTP_*`, ./smtp-config.ts) for SAM's own email on installs without the binding, such
 *   as a self-hosted celld box. Today that is sign-in codes only.
 * `emailTransportKind` is the one place that decides which one an install has. The binding wins
 * whenever it exists, so a Cloudflare deployment behaves exactly as before.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { agentEmailDomain } from './address';
import { sendSmtpMessage, type SmtpConnect } from './smtp-client';
import { resolveSmtpConfig, type SmtpConfig, type SmtpEnv } from './smtp-config';
import { buildSmtpMessage } from './smtp-message';

export interface OutboundAgentEmail {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  /** Where answers go when it is not `from` (SMTP replies on a self-hosted box; never Cloudflare). */
  replyTo?: string;
}

export interface AgentEmailSender {
  send(message: OutboundAgentEmail): Promise<{ providerMessageId: string }>;
}

export function createCloudflareAgentEmailSender(binding: SendEmail): AgentEmailSender {
  return {
    async send(message) {
      const result = await binding.send({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        headers: message.headers,
      });
      return { providerMessageId: result.messageId };
    },
  };
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export function createSmtpAgentEmailSender(
  config: SmtpConfig,
  options: { timeoutMs: number; heloName: string; connectSocket?: SmtpConnect }
): AgentEmailSender {
  return {
    async send(message) {
      const domain = config.from.split('@')[1] ?? options.heloName;
      const messageId = `${randomHex(16)}@${domain}`;
      const built = buildSmtpMessage(message, { now: new Date(), messageId });
      await sendSmtpMessage(config, built, options);
      return { providerMessageId: messageId };
    },
  };
}

/** The Cloudflare sender, or null when this deployment has no agent email binding. */
export function agentEmailSenderFor(env: Pick<Env, 'AGENT_EMAIL'>): AgentEmailSender | null {
  return env.AGENT_EMAIL ? createCloudflareAgentEmailSender(env.AGENT_EMAIL) : null;
}

export type EmailTransportEnv = Pick<Env, 'AGENT_EMAIL' | 'BASE_DOMAIN'> & SmtpEnv;
export type EmailTransportKind = 'cloudflare' | 'smtp';

/** Problems already logged by this isolate, so a bad setting is reported once, not per request. */
const reportedProblems = new Set<string>();

/** Which transport SAM's own email uses here, or null when it can send none. */
export function emailTransportKind(env: EmailTransportEnv): EmailTransportKind | null {
  if (!env.BASE_DOMAIN?.trim()) return null;
  if (env.AGENT_EMAIL) return 'cloudflare';
  const smtp = resolveSmtpConfig(env);
  if (smtp.status === 'ok') return 'smtp';
  if (smtp.status === 'invalid' && !reportedProblems.has(smtp.problem)) {
    reportedProblems.add(smtp.problem);
    log.error('email_transport.smtp_settings_invalid', { problem: smtp.problem });
  }
  return null;
}

export interface EmailTransport {
  kind: EmailTransportKind;
  sender: AgentEmailSender;
  /** The address SAM's own email to `localPart` comes from on this transport. */
  systemFrom(localPart: string): string;
}

/** The sender for SAM's own email, chosen by `emailTransportKind`. */
export function systemEmailTransportFor(
  env: EmailTransportEnv,
  options: { smtpTimeoutMs: number; connectSocket?: SmtpConnect }
): EmailTransport | null {
  const kind = emailTransportKind(env);
  if (kind === 'cloudflare' && env.AGENT_EMAIL) {
    const domain = agentEmailDomain(env.BASE_DOMAIN);
    return {
      kind,
      sender: createCloudflareAgentEmailSender(env.AGENT_EMAIL),
      systemFrom: (localPart) => `${localPart}@${domain}`,
    };
  }
  const smtp = resolveSmtpConfig(env);
  if (kind !== 'smtp' || smtp.status !== 'ok') return null;
  return {
    kind,
    sender: createSmtpAgentEmailSender(smtp.config, {
      timeoutMs: options.smtpTimeoutMs,
      heloName: `api.${env.BASE_DOMAIN.trim()}`,
      connectSocket: options.connectSocket,
    }),
    // The relay decides which senders it accepts, so every SMTP message uses SMTP_FROM.
    systemFrom: () => smtp.config.from,
  };
}
