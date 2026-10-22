/**
 * Agent email provider boundary (idea 01KS4Y3NV0Q51T0MQ6XG0GXD16): trigger, session and
 * tool code use these provider-neutral shapes. Cloudflare Email Sending is the first
 * implementation; another provider replaces only this file.
 */
import type { Env } from '../../env';

export interface OutboundAgentEmail {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
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

/** The configured sender, or null when this deployment has no agent email binding. */
export function agentEmailSenderFor(env: Pick<Env, 'AGENT_EMAIL'>): AgentEmailSender | null {
  return env.AGENT_EMAIL ? createCloudflareAgentEmailSender(env.AGENT_EMAIL) : null;
}
