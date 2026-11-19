/**
 * Inbound agent email for a celld box: the `mail-in` compose profile runs sam-mx
 * (deploy/selfhost/sam-mx), an SMTP receiver on port 25 that hands agent mail to the Worker's
 * loopback gateway route. The Worker turns agent email on only when the deploy tells it the
 * receiver is installed (AGENT_EMAIL_INBOUND_SMTP, apps/api/src/services/agent-email/
 * self-host-inbound.ts), and replies need an SMTP transport, so the profile without one is refused
 * here rather than deploying addresses whose agents cannot answer.
 */
import { composeProfiles } from './mail-settings.js';

export const MAIL_IN_PROFILE = 'mail-in';

type Box = Readonly<Record<string, string>>;

export function inboundMailEnabled(box: Box): boolean {
  return composeProfiles(box).includes(MAIL_IN_PROFILE);
}

/** Worker vars for inbound agent email ({} when the profile is off). */
export function inboundMailWorkerVars(
  box: Box,
  smtpVars: Readonly<Record<string, string>>
): Record<string, string> {
  if (!inboundMailEnabled(box)) return {};
  if (!smtpVars.SMTP_HOST) {
    throw new Error(
      `the ${MAIL_IN_PROFILE} profile needs an SMTP relay for agent replies: set SMTP_HOST ` +
        '(or, on a test install, add mail-collector to COMPOSE_PROFILES)'
    );
  }
  return { AGENT_EMAIL_INBOUND_SMTP: 'true' };
}
