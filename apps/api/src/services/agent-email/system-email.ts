/**
 * The transport for SAM's own email (sign-in codes, owner security alerts), resolved the same way
 * for every caller: the Cloudflare `AGENT_EMAIL` binding when it exists, otherwise SMTP (`SMTP_*`,
 * a self-hosted celld box), otherwise none (`emailTransportKind`). The SMTP timeout setting is
 * read only when SMTP is the transport, so a Cloudflare send costs no settings read.
 */
import type { Env } from '../../env';
import { type EmailTransport, emailTransportKind, systemEmailTransportFor } from './provider';
import { getAgentEmailLimits } from './settings';

/** The transport SAM's own email goes out through here, or null when it can send none. */
export async function resolveSystemEmailTransport(env: Env): Promise<EmailTransport | null> {
  const kind = emailTransportKind(env);
  if (!kind) return null;
  const smtpTimeoutMs = kind === 'smtp' ? (await getAgentEmailLimits(env)).smtpTimeoutMs : 0;
  return systemEmailTransportFor(env, { smtpTimeoutMs });
}
