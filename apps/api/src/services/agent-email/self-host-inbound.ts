/**
 * Agent email on a self-hosted box, without Cloudflare Email Routing or Email Sending.
 *
 * Inbound: the box's sam-mx SMTP receiver (deploy/selfhost/sam-mx, compose profile `mail-in`)
 * accepts mail for `agents.<BASE_DOMAIN>`, checks that the From domain is authenticated (aligned
 * SPF or DKIM), and posts each message during the SMTP session to the loopback gateway route
 * `POST /api/self-host/gateway/inbound-email` (routes/self-host-gateway-inbound-email.ts), which
 * calls the same `handleInboundAgentEmail` the Worker's `email()` export calls on Cloudflare.
 *
 * Outbound: replies go through the SMTP relay SAM already uses for sign-in codes
 * (`systemEmailTransportFor`). The relay decides which senders it accepts, so a reply comes
 * From `SMTP_FROM` (the trigger's name as display name) with `Reply-To` set to the trigger's own
 * agent address: the recipient's answer goes back to the same trigger and the thread continues.
 *
 * The switch is the deploy's declaration that the receiver is installed
 * (`AGENT_EMAIL_INBOUND_SMTP='true'`, scripts/selfhost/inbound-mail-settings.ts), plus the two
 * things the feature cannot work without: the gateway secret the receiver authenticates with and
 * a working SMTP transport for replies. The Cloudflare binding always wins, so a Cloudflare
 * deployment behaves exactly as before.
 */
import {
  type AgentEmailSender,
  type EmailTransportEnv,
  emailTransportKind,
  type SmtpConnect,
  systemEmailTransportFor,
} from '@simple-agent-manager/agent-email';
import { AGENT_EMAIL_LOCAL_PART } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { getReverseTunnelGatewaySecret } from '../node-reverse-tunnel-config';

export type SelfHostInboundEnv = EmailTransportEnv &
  Pick<Env, 'AGENT_EMAIL_INBOUND_SMTP' | 'REVERSE_TUNNEL_GATEWAY_SECRET'>;

/** Agent email runs on this install through sam-mx and SMTP (and not through Cloudflare). */
export function isSelfHostInboundEmailConfigured(env: SelfHostInboundEnv): boolean {
  if (env.AGENT_EMAIL || !env.BASE_DOMAIN?.trim()) return false;
  if (env.AGENT_EMAIL_INBOUND_SMTP?.trim().toLowerCase() !== 'true') return false;
  if (!getReverseTunnelGatewaySecret(env)) return false;
  return emailTransportKind(env) === 'smtp';
}

/** Whether this install can receive agent email at all (Cloudflare binding or sam-mx). */
export function hasInboundAgentEmail(env: SelfHostInboundEnv): boolean {
  return (
    Boolean(env.AGENT_EMAIL && env.BASE_DOMAIN?.trim()) || isSelfHostInboundEmailConfigured(env)
  );
}

/**
 * The SMTP reply sender for a self-hosted install, or null when it is not configured. Every
 * reply is From SMTP_FROM with Reply-To naming the agent address the caller sent From.
 */
export function selfHostAgentEmailSender(
  env: SelfHostInboundEnv,
  options: { smtpTimeoutMs: number; connectSocket?: SmtpConnect }
): AgentEmailSender | null {
  if (!isSelfHostInboundEmailConfigured(env)) return null;
  const transport = systemEmailTransportFor(env, options);
  if (transport?.kind !== 'smtp') return null;
  return {
    send(message) {
      return transport.sender.send({
        ...message,
        from: { email: transport.systemFrom(AGENT_EMAIL_LOCAL_PART), name: message.from.name },
        replyTo: message.from.email,
      });
    },
  };
}
