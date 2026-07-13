import type { WebhookDeliveryOutcome } from '@simple-agent-manager/shared';
import { type Context, Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
  isRateLimitReached,
} from '../middleware/rate-limit';
import {
  admitAndSubmitTriggerExecution,
  type TriggerTaskSubmitter,
} from '../services/trigger-admission';
import { renderTemplate } from '../services/trigger-template';
import {
  areWebhookTriggersEnabled,
  getWebhookTriggerLimits,
} from '../services/webhook-trigger-config';
import {
  fingerprintWebhookRequest,
  hashWebhookIdempotencyKey,
  isWebhookTokenFormat,
} from '../services/webhook-trigger-crypto';
import {
  buildWebhookContext,
  evaluateWebhookFilters,
  parseWebhookJsonObject,
  selectWebhookHeaders,
} from '../services/webhook-trigger-payload';
import {
  createWebhookDelivery,
  findWebhookTriggerByToken,
  finishWebhookDelivery,
  linkWebhookDeliveryExecution,
  recordWebhookRejectedDelivery,
} from '../services/webhook-trigger-store';

class BodyTooLargeError extends Error {}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
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

function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1]?.trim() || null;
}

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

async function takeRateLimit(
  env: Env,
  prefix: string,
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<{ limited: boolean; windowStart: number }> {
  const windowStart = getCurrentWindowStart(windowSeconds);
  const key = createRateLimitKey(prefix, identifier, windowStart);
  return {
    limited: !(await checkRateLimit(env.KV, key, limit, windowSeconds)).allowed,
    windowStart,
  };
}

function publicError(status: 400 | 404 | 413 | 415 | 429 | 503, message: string): Response {
  return Response.json({ accepted: false, message }, { status });
}

async function invalidTokenResponse(
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

async function invalidTokenLimitReached(
  env: Env,
  ipKey: string,
  limits: ReturnType<typeof getWebhookTriggerLimits>
): Promise<boolean> {
  const windowStart = getCurrentWindowStart(limits.rateLimitWindowSeconds);
  return isRateLimitReached(
    env.KV,
    createRateLimitKey('webhook-invalid', ipKey, windowStart),
    limits.invalidTokenRateLimit,
    windowStart
  );
}

async function recordRejected(
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

async function handleWebhookIngress(
  c: Context<{ Bindings: Env }>,
  submitter?: TriggerTaskSubmitter
) {
  if (!areWebhookTriggersEnabled(c.env)) return publicError(404, 'Not found');

  const limits = getWebhookTriggerLimits(c.env);
  const ipKey = await fingerprintWebhookRequest(clientIp(c.req.raw), c.env.ENCRYPTION_KEY);
  const ingressRate = await takeRateLimit(
    c.env,
    'webhook-ingress',
    ipKey,
    limits.ingressRateLimit,
    limits.rateLimitWindowSeconds
  );
  if (ingressRate.limited) return publicError(429, 'Too many requests');

  const token = bearerToken(c.req.header('Authorization'));
  if (!token || !isWebhookTokenFormat(token)) {
    return invalidTokenResponse(c.env, ipKey, limits);
  }
  if (await invalidTokenLimitReached(c.env, ipKey, limits)) {
    return publicError(429, 'Too many requests');
  }

  const resolved = await findWebhookTriggerByToken(c.env, token);
  if (!resolved) return invalidTokenResponse(c.env, ipKey, limits);

  const receivedAt = new Date().toISOString();
  const rejectionWindow = getCurrentWindowStart(limits.rateLimitWindowSeconds);
  if (!resolved.trigger.agentProfileId) {
    await recordRejected(c.env, {
      triggerId: resolved.trigger.id,
      outcome: 'configuration_error',
      httpStatus: 503,
      errorCode: 'missing_agent_profile',
      windowStart: rejectionWindow,
      receivedAt,
    });
    return publicError(503, 'Webhook trigger is not configured');
  }

  const triggerRate = await takeRateLimit(
    c.env,
    'webhook-trigger',
    resolved.trigger.id,
    limits.triggerRateLimit,
    limits.rateLimitWindowSeconds
  );
  if (triggerRate.limited) {
    await recordRejected(c.env, {
      triggerId: resolved.trigger.id,
      outcome: 'rate_limited',
      httpStatus: 429,
      errorCode: 'rate_limited',
      windowStart: triggerRate.windowStart,
      receivedAt,
    });
    return publicError(429, 'Too many requests');
  }

  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return publicError(415, 'Content-Type must be application/json');
  }
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
  let rawBody: string;
  try {
    rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bodyBytes);
  } catch {
    return publicError(400, 'Request body must be valid UTF-8 JSON');
  }
  const body = parseWebhookJsonObject(rawBody);
  if (!body) return publicError(400, 'Request body must be a JSON object');

  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > limits.maxIdempotencyKeyLength) {
    return publicError(400, 'Idempotency-Key is too long');
  }

  const delivery = await createWebhookDelivery(c.env, {
    triggerId: resolved.trigger.id,
    idempotencyKeyHash: idempotencyKey
      ? await hashWebhookIdempotencyKey(idempotencyKey, c.env.ENCRYPTION_KEY)
      : null,
    requestFingerprint: await fingerprintWebhookRequest(rawBody, c.env.ENCRYPTION_KEY),
    bodyBytes: bodyBytes.byteLength,
    receivedAt,
  });
  if (delivery.disposition === 'duplicate') {
    return c.json(
      {
        accepted: true,
        duplicate: true,
        deliveryId: delivery.id,
        executionId: delivery.executionId,
      },
      202
    );
  }
  if (delivery.disposition === 'in_flight') {
    return publicError(503, 'Webhook is still processing');
  }
  if (delivery.disposition === 'failed') {
    return publicError(503, 'Webhook could not be processed');
  }

  const finalize = async (
    outcome: WebhookDeliveryOutcome,
    httpStatus: number,
    executionId?: string,
    errorCode?: string
  ) => {
    await finishWebhookDelivery(c.env, {
      id: delivery.id,
      triggerId: resolved.trigger.id,
      outcome,
      httpStatus,
      processingToken: delivery.processingToken,
      executionId,
      errorCode,
    });
  };

  let externallySubmitted = false;
  let submittedExecutionId: string | undefined;
  try {
    const filterResult = evaluateWebhookFilters(
      body,
      resolved.config.filters,
      resolved.config.filterMode,
      limits.maxFilterPathDepth
    );
    if (!filterResult.matched) {
      await finalize('filtered', 202);
      return c.json({ accepted: true, filtered: true, deliveryId: delivery.id }, 202);
    }

    const safeHeaders = selectWebhookHeaders(c.req.raw.headers, resolved.config.includedHeaders);
    const admission = await admitAndSubmitTriggerExecution(
      c.env,
      {
        trigger: resolved.trigger,
        eventType: 'webhook',
        triggeredBy: 'webhook',
        scheduledAt: receivedAt,
        beforeSubmit: (executionId) =>
          linkWebhookDeliveryExecution(
            c.env,
            resolved.trigger.id,
            delivery.id,
            executionId,
            delivery.processingToken
          ),
        renderPrompt: (executionId, sequenceNumber) => {
          const context = buildWebhookContext({
            body,
            headers: safeHeaders,
            receivedAt,
            deliveryId: delivery.id,
            sourceLabel: resolved.config.sourceLabel,
            trigger: resolved.trigger,
            projectName: resolved.projectName,
            executionId,
            sequenceNumber,
          });
          return renderTemplate(
            resolved.trigger.promptTemplate,
            context as unknown as Record<string, unknown>
          ).rendered;
        },
      },
      submitter
    );

    if (admission.outcome === 'submitted') {
      externallySubmitted = true;
      submittedExecutionId = admission.executionId;
      await finalize('accepted', 202, admission.executionId);
      return c.json(
        { accepted: true, deliveryId: delivery.id, executionId: admission.executionId },
        202
      );
    }
    if (admission.outcome === 'pending') {
      log.warn('webhook_trigger.submission_pending', {
        triggerId: resolved.trigger.id,
        deliveryId: delivery.id,
        executionId: admission.executionId,
        taskId: admission.taskId,
      });
      return publicError(503, 'Webhook is still processing');
    }
    if (admission.outcome === 'skipped') {
      await finalize(admission.reason, 202, admission.executionId);
      return c.json({ accepted: true, skipped: admission.reason, deliveryId: delivery.id }, 202);
    }
    if (admission.outcome === 'inactive') {
      await finalize('inactive', 202, undefined, admission.reason);
      return c.json({ accepted: true, inactive: true, deliveryId: delivery.id }, 202);
    }

    // Preserve the durable linkage only if beforeSubmit committed it. Passing the
    // execution ID here would make a failed linkage look submitted and prevent a
    // safe pre-submission retry.
    await finalize('internal_error', 503, undefined, 'submission_failed');
    log.error('webhook_trigger.ingest_failed', {
      triggerId: resolved.trigger.id,
      deliveryId: delivery.id,
      executionId: admission.executionId,
    });
    return publicError(503, 'Webhook could not be processed');
  } catch (error) {
    if (!externallySubmitted) {
      await finalize('internal_error', 503, undefined, 'processing_failed').catch(() => {});
    }
    log.error('webhook_trigger.ingest_internal_error', {
      triggerId: resolved.trigger.id,
      deliveryId: delivery.id,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    if (externallySubmitted && submittedExecutionId) {
      await finalize('accepted', 202, submittedExecutionId).catch((reconciliationError) => {
        log.error('webhook_trigger.delivery_reconciliation_failed', {
          triggerId: resolved.trigger.id,
          deliveryId: delivery.id,
          executionId: submittedExecutionId,
          errorType:
            reconciliationError instanceof Error ? reconciliationError.name : 'UnknownError',
        });
      });
      return c.json(
        { accepted: true, deliveryId: delivery.id, executionId: submittedExecutionId },
        202
      );
    }
    return publicError(503, 'Webhook could not be processed');
  }
}

export function createTriggerWebhookRoutes(submitter?: TriggerTaskSubmitter) {
  const routes = new Hono<{ Bindings: Env }>();
  routes.post('/ingest', async (c) => {
    try {
      return await handleWebhookIngress(c, submitter);
    } catch (error) {
      log.error('webhook_trigger.ingest_internal_error', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return publicError(503, 'Webhook could not be processed');
    }
  });
  return routes;
}

const triggerWebhookRoutes = createTriggerWebhookRoutes();

export { triggerWebhookRoutes };
