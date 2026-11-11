/**
 * Public address for signed webhook automations: `POST /api/webhooks/in/:triggerId`.
 *
 * The sender cannot present SAM's token, so the address names the automation and the request
 * proves itself with an HMAC over its raw bytes (services/webhook-signature.ts). Nothing in the
 * body is read, and nothing is recorded against the automation's limits, until that check
 * passes. A verified event is committed to the durable queue before the 202; starting the run
 * happens after the response and again from the cron drain (services/webhook-trigger-queue.ts).
 *
 * The sender is untrusted. A valid signature proves which provider sent the event, not that its
 * author may act for the project: the run starts with the automation's stored profile and
 * instructions, and the event content reaches it as data.
 */
import type { WebhookRejectionReason } from '@simple-agent-manager/shared';
import { type Context, Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCurrentWindowStart } from '../middleware/rate-limit';
import { optionalExecutionContext } from '../services/ai-token-usage-accounting';
import { enqueueGenericWebhookProjectEvent } from '../services/generic-webhook-project-event-producer';
import type { TriggerTaskSubmitter } from '../services/trigger-admission';
import { drainTriggerQueueForTrigger } from '../services/trigger-queue-drain';
import { renderTemplate } from '../services/trigger-template';
import {
  BodyTooLargeError,
  clientIp,
  invalidTokenLimitReached,
  invalidTokenResponse,
  publicError,
  rateLimitSubject,
  readBoundedBody,
  recordRejected,
  takeRateLimit,
  webhookDeliveryDispositionResponse,
} from '../services/webhook-ingress-http';
import { verifyWebhookSignature } from '../services/webhook-signature';
import {
  decryptWebhookSigningSecret,
  findSignedWebhookTrigger,
  recordWebhookSignedNotice,
  type ResolvedSignedWebhookTrigger,
} from '../services/webhook-signed-store';
import {
  areWebhookTriggersEnabled,
  getWebhookQueueSettings,
  getWebhookTriggerLimits,
} from '../services/webhook-trigger-config';
import {
  fingerprintWebhookRequest,
  hashWebhookIdempotencyKey,
} from '../services/webhook-trigger-crypto';
import {
  buildWebhookContext,
  evaluateWebhookFilters,
  parseWebhookJsonObject,
  readWebhookEventId,
  selectWebhookHeaders,
} from '../services/webhook-trigger-payload';
import { acceptWebhookTriggerExecution } from '../services/webhook-trigger-queue';
import { createWebhookDelivery, finishWebhookDelivery } from '../services/webhook-trigger-store';

type SignedContext = Context<{ Bindings: Env }>;

const TRIGGER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Work that must not delay the answer: project events and starting the run. When the runtime
 * gives no execution context (tests), it runs before the response instead.
 */
async function afterResponse(c: SignedContext, work: () => Promise<unknown>): Promise<void> {
  const guarded = work().catch((error) => {
    log.warn('webhook_trigger.post_response_work_failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  });
  const context = optionalExecutionContext(() => c.executionCtx);
  if (context) context.waitUntil(guarded);
  else await guarded;
}

interface RefusalInput {
  resolved: ResolvedSignedWebhookTrigger;
  reason: WebhookRejectionReason;
  httpStatus: number;
  bodyBytes: number;
  receivedAt: string;
  windowStart: number;
}

/**
 * Records a refusal once per window and, for the first one in the window, tells the project.
 * No request content is recorded: the call was not verified, or could not be read as an event.
 */
/** Refusals that happen after the signature verified. */
const SIGNED_REFUSALS: ReadonlySet<WebhookRejectionReason> = new Set([
  'stale_timestamp',
  'invalid_body',
  'missing_event_id',
]);

async function recordRefusal(c: SignedContext, input: RefusalInput): Promise<void> {
  const { resolved } = input;
  try {
    const notice = await recordWebhookSignedNotice(c.env, {
      triggerId: resolved.trigger.id,
      outcome: 'rejected',
      reason: input.reason,
      httpStatus: input.httpStatus,
      bodyBytes: input.bodyBytes,
      windowStart: input.windowStart,
      receivedAt: input.receivedAt,
    });
    // A project event can wake subscribed agents. Refusals anyone can cause by knowing the
    // address (no secret saved, a forged signature) are kept to the call log and the setup
    // status; only refusals of signed requests, which come from whoever holds the secret,
    // become events.
    if (!notice.created || !SIGNED_REFUSALS.has(input.reason)) return;
    await afterResponse(c, () =>
      enqueueGenericWebhookProjectEvent(c.env, {
        trigger: resolved.trigger,
        config: resolved.config,
        projectName: resolved.projectName,
        deliveryId: notice.id,
        outcome: 'rejected',
        reason: input.reason,
        receivedAt: input.receivedAt,
        body: {},
        headers: {},
      })
    );
  } catch (error) {
    log.warn('webhook_trigger.rejection_audit_failed', {
      triggerId: resolved.trigger.id,
      outcome: 'rejected',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function answerChallenge(
  c: SignedContext,
  resolved: ResolvedSignedWebhookTrigger,
  challenge: string,
  bodyBytes: number,
  receivedAt: string,
  windowStart: number
): Promise<Response> {
  try {
    const notice = await recordWebhookSignedNotice(c.env, {
      triggerId: resolved.trigger.id,
      outcome: 'challenge',
      reason: 'url_verification',
      httpStatus: 200,
      bodyBytes,
      windowStart,
      receivedAt,
    });
    if (notice.created) {
      await afterResponse(c, () =>
        enqueueGenericWebhookProjectEvent(c.env, {
          trigger: resolved.trigger,
          config: resolved.config,
          projectName: resolved.projectName,
          deliveryId: notice.id,
          outcome: 'challenge',
          receivedAt,
          body: {},
          headers: {},
        })
      );
    }
  } catch (error) {
    // The handshake still succeeds: Slack will not save the address otherwise.
    log.warn('webhook_trigger.challenge_audit_failed', {
      triggerId: resolved.trigger.id,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  return new Response(challenge, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function handleSignedWebhook(c: SignedContext, submitter?: TriggerTaskSubmitter) {
  if (!areWebhookTriggersEnabled(c.env)) return publicError(404, 'Not found');

  const limits = getWebhookTriggerLimits(c.env);
  const ipKey = await fingerprintWebhookRequest(
    rateLimitSubject(clientIp(c.req.raw)),
    c.env.ENCRYPTION_KEY
  );
  const ingressRate = await takeRateLimit(
    c.env,
    'webhook-ingress',
    ipKey,
    limits.ingressRateLimit,
    limits.rateLimitWindowSeconds
  );
  if (ingressRate.limited) return publicError(429, 'Too many requests');

  const triggerId = c.req.param('triggerId') ?? '';
  if (!TRIGGER_ID_PATTERN.test(triggerId)) return invalidTokenResponse(c.env, ipKey, limits);
  if (await invalidTokenLimitReached(c.env, ipKey, limits)) {
    return publicError(429, 'Too many requests');
  }
  const resolved = await findSignedWebhookTrigger(c.env, triggerId);
  if (!resolved) return invalidTokenResponse(c.env, ipKey, limits);
  const { trigger } = resolved;

  const receivedAt = new Date().toISOString();
  const windowStart = getCurrentWindowStart(limits.rateLimitWindowSeconds);

  const contentLength = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > limits.maxBodyBytes) {
    return publicError(413, 'Request body is too large');
  }
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = await readBoundedBody(c.req.raw, limits.maxBodyBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return publicError(413, 'Request body is too large');
    throw error;
  }
  const refuse = (reason: WebhookRejectionReason, httpStatus: number) =>
    recordRefusal(c, {
      resolved,
      reason,
      httpStatus,
      bodyBytes: bodyBytes.byteLength,
      receivedAt,
      windowStart,
    });

  // A stored secret that cannot be read back is bad data, not a server fault: the call is
  // refused the same visible way as when none is saved, and saving the secret again repairs it.
  const secret = resolved.encryptedSecret
    ? await decryptWebhookSigningSecret(c.env, resolved.encryptedSecret).catch(() => {
        log.error('webhook_trigger.signing_secret_unreadable', { triggerId: trigger.id });
        return null;
      })
    : null;
  if (secret === null) {
    await refuse('not_configured', 503);
    return publicError(503, 'Webhook signing secret is not configured');
  }
  const settings = await getWebhookQueueSettings(c.env);
  const verification = await verifyWebhookSignature(resolved.scheme, {
    secret,
    rawBody: bodyBytes,
    headers: c.req.raw.headers,
    nowMs: Date.now(),
    toleranceSeconds: settings.signatureToleranceSeconds,
    signatureHeader: resolved.signatureHeader,
  });
  if (!verification.ok) {
    await refuse(verification.reason, 401);
    return publicError(
      401,
      verification.reason === 'stale_timestamp'
        ? 'Request timestamp is outside the allowed window'
        : 'Invalid signature'
    );
  }

  // The sender is verified from here on.
  if (!trigger.agentProfileId) {
    await recordRejected(c.env, {
      triggerId: trigger.id,
      outcome: 'configuration_error',
      httpStatus: 503,
      errorCode: 'missing_agent_profile',
      windowStart,
      receivedAt,
    });
    return publicError(503, 'Webhook trigger is not configured');
  }
  const triggerRate = await takeRateLimit(
    c.env,
    'webhook-trigger',
    trigger.id,
    limits.triggerRateLimit,
    limits.rateLimitWindowSeconds
  );
  if (triggerRate.limited) {
    await recordRejected(c.env, {
      triggerId: trigger.id,
      outcome: 'rate_limited',
      httpStatus: 429,
      errorCode: 'rate_limited',
      windowStart: triggerRate.windowStart,
      receivedAt,
    });
    return publicError(429, 'Too many requests');
  }

  let rawBody: string | null = null;
  try {
    rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bodyBytes);
  } catch {
    rawBody = null;
  }
  const body = rawBody === null ? null : parseWebhookJsonObject(rawBody);
  if (rawBody === null || !body) {
    await refuse('invalid_body', 400);
    return publicError(400, 'Request body must be a JSON object');
  }

  // Slack checks the address with a signed `url_verification` request. It is answered with the
  // challenge and nothing else: no duplicate key, no conditions, no run.
  if (
    resolved.scheme === 'slack_v0' &&
    body.type === 'url_verification' &&
    typeof body.challenge === 'string'
  ) {
    return answerChallenge(
      c,
      resolved,
      body.challenge,
      bodyBytes.byteLength,
      receivedAt,
      windowStart
    );
  }

  const eventId = readWebhookEventId(
    resolved.eventId,
    body,
    c.req.raw.headers,
    limits.maxFilterPathDepth
  );
  if (!eventId) {
    // A success status: the sender is verified and the fault is in SAM's configuration, and a
    // failure status would make providers such as Slack switch the subscription off. No run
    // starts, and the duplicate check is never skipped.
    await refuse('missing_event_id', 202);
    return c.json({ accepted: true, ignored: 'missing_event_id' }, 202);
  }

  const delivery = await createWebhookDelivery(c.env, {
    triggerId: trigger.id,
    idempotencyKeyHash: await hashWebhookIdempotencyKey(eventId, c.env.ENCRYPTION_KEY),
    requestFingerprint: await fingerprintWebhookRequest(rawBody, c.env.ENCRYPTION_KEY),
    bodyBytes: bodyBytes.byteLength,
    receivedAt,
    // An ID in a header is outside what the sender signed. Without this, someone holding one
    // captured request could replay its body under a fresh ID each time.
    requireNewBody: Boolean(resolved.eventId && 'header' in resolved.eventId),
  });
  if (delivery.disposition !== 'reserved') return webhookDeliveryDispositionResponse(delivery);

  const finalize = (
    outcome: Parameters<typeof finishWebhookDelivery>[1]['outcome'],
    httpStatus: number,
    errorCode?: string
  ) =>
    finishWebhookDelivery(c.env, {
      id: delivery.id,
      triggerId: trigger.id,
      outcome,
      httpStatus,
      processingToken: delivery.processingToken,
      errorCode,
    });
  // The signature header never reaches the instructions, whatever the stored allowlist says.
  const safeHeaders = selectWebhookHeaders(
    c.req.raw.headers,
    resolved.config.includedHeaders.filter((name) => name !== resolved.signatureHeader)
  );
  const projectEvent = (outcome: 'filtered' | 'accepted' | 'inactive', executionId?: string) =>
    afterResponse(c, () =>
      enqueueGenericWebhookProjectEvent(c.env, {
        trigger,
        config: resolved.config,
        projectName: resolved.projectName,
        deliveryId: delivery.id,
        outcome,
        receivedAt,
        body,
        headers: safeHeaders,
        executionId,
      })
    );

  try {
    const filterResult = evaluateWebhookFilters(
      body,
      resolved.config.filters,
      resolved.config.filterMode,
      limits.maxFilterPathDepth
    );
    if (!filterResult.matched) {
      await finalize('filtered', 202);
      await projectEvent('filtered');
      return c.json({ accepted: true, filtered: true, deliveryId: delivery.id }, 202);
    }

    const accepted = await acceptWebhookTriggerExecution(c.env, {
      trigger,
      delivery: { id: delivery.id, processingToken: delivery.processingToken },
      receivedAt,
      maxPending: settings.maxPending,
      ttlSeconds: settings.ttlSeconds,
      renderPrompt: (executionId, sequenceNumber) =>
        renderTemplate(
          trigger.promptTemplate,
          buildWebhookContext({
            body,
            headers: safeHeaders,
            receivedAt,
            deliveryId: delivery.id,
            sourceLabel: resolved.config.sourceLabel,
            trigger,
            projectName: resolved.projectName,
            executionId,
            sequenceNumber,
          }) as unknown as Record<string, unknown>
        ).rendered,
    });

    if (accepted.outcome === 'queued') {
      // Committed: the event now survives this request. Everything below is best effort.
      await projectEvent('accepted', accepted.executionId);
      // At most as many events as the automation may run at once can start now; the cron
      // drain is the recovery path for everything else.
      await afterResponse(c, () =>
        drainTriggerQueueForTrigger(
          c.env,
          trigger.id,
          trigger.skipIfRunning ? 1 : Math.max(1, trigger.maxConcurrent),
          submitter
        )
      );
      return c.json(
        {
          accepted: true,
          queued: true,
          deliveryId: delivery.id,
          executionId: accepted.executionId,
        },
        202
      );
    }
    if (accepted.outcome === 'queue_full') {
      // Backpressure. The event ID is not consumed, so the sender's retry can be accepted.
      await finalize('queue_full', 429, 'queue_full');
      // The line moves no faster than the rate-limit window, so that is the earliest retry
      // worth making.
      return publicError(429, 'Too many events are waiting for this automation', {
        'Retry-After': String(limits.rateLimitWindowSeconds),
      });
    }
    if (accepted.outcome === 'inactive') {
      await finalize('inactive', 202, accepted.reason);
      await projectEvent('inactive');
      return c.json({ accepted: true, inactive: true, deliveryId: delivery.id }, 202);
    }
    await finalize('internal_error', 503, accepted.reason);
    log.warn('webhook_trigger.queue_accept_unavailable', {
      triggerId: trigger.id,
      deliveryId: delivery.id,
      reason: accepted.reason,
    });
    return publicError(503, 'Webhook could not be processed');
  } catch (error) {
    // Nothing was committed to the queue on this path, so the same event may be retried.
    await finalize('internal_error', 503, 'processing_failed').catch(() => {});
    log.error('webhook_trigger.signed_ingest_internal_error', {
      triggerId: trigger.id,
      deliveryId: delivery.id,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return publicError(503, 'Webhook could not be processed');
  }
}

export function createSignedTriggerWebhookRoutes(submitter?: TriggerTaskSubmitter) {
  const routes = new Hono<{ Bindings: Env }>();
  routes.post('/in/:triggerId', async (c) => {
    try {
      return await handleSignedWebhook(c, submitter);
    } catch (error) {
      log.error('webhook_trigger.signed_ingest_internal_error', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return publicError(503, 'Webhook could not be processed');
    }
  });
  return routes;
}

export const signedTriggerWebhookRoutes = createSignedTriggerWebhookRoutes();
