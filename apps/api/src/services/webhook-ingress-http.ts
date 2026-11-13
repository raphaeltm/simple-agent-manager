/** Request plumbing shared by the two public webhook addresses (token and signed). */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { clientIpFromHeaders } from '../lib/client-ip';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
  isRateLimitReached,
} from '../middleware/rate-limit';
import type { getWebhookTriggerLimits } from './webhook-trigger-config';
import { recordWebhookRejectedDelivery } from './webhook-trigger-store';

export class BodyTooLargeError extends Error {}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk.value);
    chunk = await reader.read();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function clientIp(request: Request): string {
  return clientIpFromHeaders((name) => request.headers.get(name)) ?? 'unknown';
}

/**
 * The per-caller rate-limit identity. One IPv6 host is normally given a whole /64, so counting
 * each address separately would let one host take as many buckets as it likes; IPv6 callers are
 * counted per /64. IPv4 and unparseable values are used as they are.
 */
export function rateLimitSubject(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [
        ...headGroups,
        ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'),
        ...tailGroups,
      ]
    : headGroups;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return ip;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

export async function takeRateLimit(
  env: Env,
  prefix: string,
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<{ limited: boolean; windowStart: number }> {
  const windowStart = getCurrentWindowStart(windowSeconds);
  const key = createRateLimitKey(prefix, identifier, windowStart);
  try {
    return {
      limited: !(await checkRateLimit(env.KV, key, limit, windowSeconds)).allowed,
      windowStart,
    };
  } catch (error) {
    // KV refuses rapid writes to one key, and a burst from one sender writes the same counter.
    // A counter that cannot be read or updated must not turn a sender's event into a 503 (GitHub
    // does not redeliver): fail open. Signature checks and the queue's own bounds still apply.
    logRateLimitUnavailable(prefix, error);
    return { limited: false, windowStart };
  }
}

function logRateLimitUnavailable(prefix: string, error: unknown): void {
  log.warn('webhook_trigger.rate_limit_unavailable', {
    prefix,
    errorType: error instanceof Error ? error.name : 'UnknownError',
  });
}

/** The same codes `errors` in middleware/error.ts uses for each status. */
const PUBLIC_ERROR_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
} as const;

/**
 * The webhook ingress error body: the API's `{ error, message }` shape, plus `accepted: false`
 * for senders that already read it.
 */
export function publicError(
  status: keyof typeof PUBLIC_ERROR_CODES,
  message: string,
  headers?: Record<string, string>
): Response {
  return Response.json(
    { accepted: false, error: PUBLIC_ERROR_CODES[status], message },
    { status, headers }
  );
}

/** One uniform answer for an unknown token or address, counted per caller. */
export async function invalidTokenResponse(
  env: Env,
  ipKey: string,
  limits: ReturnType<typeof getWebhookTriggerLimits>
) {
  const { limited } = await takeRateLimit(
    env,
    'webhook-invalid',
    ipKey,
    limits.invalidTokenRateLimit,
    limits.rateLimitWindowSeconds
  );
  return limited ? publicError(429, 'Too many requests') : publicError(404, 'Not found');
}

export async function invalidTokenLimitReached(
  env: Env,
  ipKey: string,
  limits: ReturnType<typeof getWebhookTriggerLimits>
): Promise<boolean> {
  const windowStart = getCurrentWindowStart(limits.rateLimitWindowSeconds);
  try {
    return await isRateLimitReached(
      env.KV,
      createRateLimitKey('webhook-invalid', ipKey, windowStart),
      limits.invalidTokenRateLimit,
      windowStart
    );
  } catch (error) {
    // Same policy as takeRateLimit: a counter that cannot be read must not refuse a sender.
    logRateLimitUnavailable('webhook-invalid', error);
    return false;
  }
}

/** Audit only: a failure to record a refusal must not change the answer the sender gets. */
export async function recordRejected(
  env: Env,
  input: Parameters<typeof recordWebhookRejectedDelivery>[1]
): Promise<void> {
  try {
    await recordWebhookRejectedDelivery(env, input);
  } catch (error) {
    log.warn('webhook_trigger.rejection_audit_failed', {
      triggerId: input.triggerId,
      outcome: input.outcome,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

/**
 * The answer for a call that holds no fresh reservation: a repeat is acknowledged, and one
 * still being handled (or one whose handling failed) asks the sender to retry.
 */
export function webhookDeliveryDispositionResponse(
  delivery:
    | { disposition: 'duplicate'; id: string; executionId?: string | null }
    | { disposition: 'in_flight' | 'failed' }
): Response {
  if (delivery.disposition === 'duplicate') {
    return Response.json(
      {
        accepted: true,
        duplicate: true,
        deliveryId: delivery.id,
        executionId: delivery.executionId,
      },
      { status: 202 }
    );
  }
  return publicError(
    503,
    delivery.disposition === 'in_flight'
      ? 'Webhook is still processing'
      : 'Webhook could not be processed'
  );
}
