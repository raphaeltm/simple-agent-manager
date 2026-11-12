/**
 * `POST /api/self-host/gateway/inbound-email`: the box's sam-mx SMTP receiver hands one message
 * for one recipient to the inbound agent email handler, during the SMTP session.
 *
 * Request (deploy/selfhost/sam-mx/gateway.go): the raw RFC 5322 message as the body with an
 * exact Content-Length, and
 *   X-SAM-Gateway-Secret          REVERSE_TUNNEL_GATEWAY_SECRET, as for every gateway route
 *   X-SAM-Mail-From               envelope sender (MAIL FROM; empty for a null sender)
 *   X-SAM-Rcpt-To                 envelope recipient (RCPT TO)
 *   X-SAM-Mail-Auth               `pass` (aligned SPF or DKIM) or `trusted` (box loopback)
 *   X-SAM-Mail-Auth-From-Domain   the From domain the receiver authenticated
 * Response: 200 `{outcome: accepted|queued|duplicate|loopback}` or
 * `{outcome: 'rejected', reason}`, which the receiver turns into 250 or 550. Anything else
 * (401, 404, 5xx, a timeout) is a 451 there, so the sender retries and nothing is bounced.
 *
 * Trust: only box processes reach this route (Caddy answers 404 for the gateway prefix on its
 * public listener, sam.d/frp.caddy), and the shared secret authenticates the receiver. The
 * receiver is the sender-authentication authority, as Cloudflare Email Routing is on Cloudflare;
 * the handler binds its verdict to the From it parses (`authenticatedFromDomain`).
 *
 * Fails closed: 404 without the gateway secret (every Cloudflare deployment) or while the
 * self-host inbound switch is off (services/agent-email/self-host-inbound.ts).
 */
import type { Context } from 'hono';

import type { Env } from '../env';
import { constantTimeEqual } from '../lib/constant-time';
import { log } from '../lib/logger';
import {
  handleInboundAgentEmail,
  type InboundDeps,
  type InboundEmailMessage,
} from '../services/agent-email/inbound';
import { isSelfHostInboundEmailConfigured } from '../services/agent-email/self-host-inbound';
import { getReverseTunnelGatewaySecret } from '../services/node-reverse-tunnel-config';

export const INBOUND_EMAIL_HEADER = {
  secret: 'X-SAM-Gateway-Secret',
  mailFrom: 'X-SAM-Mail-From',
  rcptTo: 'X-SAM-Rcpt-To',
  auth: 'X-SAM-Mail-Auth',
  authFromDomain: 'X-SAM-Mail-Auth-From-Domain',
} as const;

/** Above the largest `agentEmail.maxInboundBytes` an admin can set (25 MiB). */
export const INBOUND_EMAIL_GATEWAY_MAX_BYTES = 25 * 1024 * 1024;

const AUTH_RESULTS = new Set(['pass', 'trusted']);
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

function badRequest(message: string): Response {
  return json({ error: 'BAD_REQUEST', message }, 400);
}

/**
 * The body, cut off with an error if it runs past the declared length: rawSize is what the
 * handler's size check reads, so it must be the size of what the parser receives.
 */
function boundedBody(
  body: ReadableStream<Uint8Array>,
  declared: number
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > declared) {
          controller.error(new Error('The message is longer than its Content-Length'));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

export async function handleInboundEmailGateway(
  c: Context<{ Bindings: Env }>,
  deps: InboundDeps = {}
): Promise<Response> {
  const secret = getReverseTunnelGatewaySecret(c.env);
  if (!secret) return json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  if (!constantTimeEqual(c.req.header(INBOUND_EMAIL_HEADER.secret) ?? '', secret)) {
    log.warn('self_host_gateway.inbound_email_unauthenticated', { action: 'rejected' });
    return json({ error: 'UNAUTHORIZED', message: 'Gateway authentication failed' }, 401);
  }
  if (!isSelfHostInboundEmailConfigured(c.env)) {
    log.warn('self_host_gateway.inbound_email_disabled', { action: 'rejected' });
    return json({ error: 'NOT_FOUND', message: 'Inbound agent email is not enabled' }, 404);
  }

  const auth = (c.req.header(INBOUND_EMAIL_HEADER.auth) ?? '').trim().toLowerCase();
  const authFromDomain = (c.req.header(INBOUND_EMAIL_HEADER.authFromDomain) ?? '')
    .trim()
    .toLowerCase();
  if (!AUTH_RESULTS.has(auth) || !DOMAIN.test(authFromDomain)) {
    log.warn('self_host_gateway.inbound_email_unauthenticated_sender', { action: 'rejected' });
    return badRequest('Sender authentication results are missing');
  }
  const rcptTo = (c.req.header(INBOUND_EMAIL_HEADER.rcptTo) ?? '').trim();
  if (!rcptTo) return badRequest('The envelope recipient is missing');
  const mailFrom = (c.req.header(INBOUND_EMAIL_HEADER.mailFrom) ?? '').trim();

  const lengthHeader = c.req.header('Content-Length') ?? '';
  const rawSize = /^\d{1,9}$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
  if (!Number.isFinite(rawSize)) return json({ error: 'LENGTH_REQUIRED' }, 411);
  if (rawSize > INBOUND_EMAIL_GATEWAY_MAX_BYTES) return json({ error: 'TOO_LARGE' }, 413);
  const body = c.req.raw.body;
  if (!body) return badRequest('The message is missing');

  let rejectReason: string | null = null;
  const message: InboundEmailMessage = {
    from: mailFrom,
    to: rcptTo,
    raw: boundedBody(body, rawSize),
    rawSize,
    setReject: (reason) => {
      rejectReason = reason;
    },
    authenticatedFromDomain: authFromDomain,
  };
  const outcome = await handleInboundAgentEmail(message, c.env, deps);
  log.info('self_host_gateway.inbound_email', { outcome: outcome.kind, auth, rawSize });
  if (outcome.kind === 'rejected') {
    return json({ outcome: 'rejected', reason: rejectReason ?? outcome.reason });
  }
  return json({ outcome: outcome.kind });
}
