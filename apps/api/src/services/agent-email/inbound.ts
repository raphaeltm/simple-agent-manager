/**
 * Inbound agent email: the logic behind the API Worker's `email()` handler.
 *
 * Mail to `agent+<key>@mail.<BASE_DOMAIN>` starts the email trigger that owns `<key>`
 * through the shared trigger admission path. Every refusal is an SMTP-time reject, so a
 * forged sender gets no backscatter. Workers cannot see SPF/DKIM/DMARC verdicts
 * (cloudflare/workerd#6740); the unguessable address plus the sender allowlist are the
 * prototype's controls, and aligned sender authentication is the production gate
 * (idea 01KS4X886T3NRKR3696H25A2AN).
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
} from '../../middleware/rate-limit';
import { admitAndSubmitTriggerExecution } from '../trigger-admission';
import { submitTriggeredTask } from '../trigger-submit';
import { agentEmailAddress, isAgentEmailAvailable, parseAgentEmailRecipient } from './address';
import { buildEmailContext, renderEmailPrompt } from './context';
import { sanitizeHeaderText } from './headers';
import { claimDelivery, finishDelivery } from './inbound-delivery';
import { type InboundAgentEmail, parseInboundEmail } from './inbound-message';
import { recordLoopbackReceipt } from './loopback';
import { type AgentEmailLimits, getAgentEmailLimits } from './settings';
import { parseAllowedSenders } from './trigger-config';

/** The parts of Cloudflare's ForwardableEmailMessage this handler uses. */
export interface InboundEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export type InboundOutcome =
  | { kind: 'accepted'; executionId: string }
  | { kind: 'duplicate' }
  | { kind: 'loopback' }
  | { kind: 'rejected'; reason: string };

export interface InboundDeps {
  submitter?: Parameters<typeof admitAndSubmitTriggerExecution>[2];
  now?: () => Date;
}

const RATE_WINDOW_SECONDS = 3600;
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);
const SYSTEM_SENDER = /^(mailer-daemon|postmaster)@/i;
const UNREADABLE = 'This email could not be read';

function reject(message: InboundEmailMessage, reason: string): InboundOutcome {
  message.setReject(reason);
  return { kind: 'rejected', reason };
}

async function withinRateLimit(env: Env, scope: string, id: string, limit: number) {
  const key = createRateLimitKey(scope, id, getCurrentWindowStart(RATE_WINDOW_SECONDS));
  return (await checkRateLimit(env.KV, key, limit, RATE_WINDOW_SECONDS)).allowed;
}

/** Parse failures (size, nesting and part limits included) are permanent: reject, never retry. */
async function readEmail(
  message: InboundEmailMessage,
  limits: AgentEmailLimits,
  logContext: Record<string, unknown>
): Promise<InboundAgentEmail | null> {
  try {
    return await parseInboundEmail(message.raw, message, limits.maxBodyChars);
  } catch (error) {
    log.warn('agent_email.inbound_parse_failed', {
      ...logContext,
      rawSize: message.rawSize,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Loop guards: never start an agent from automatic, bulk, or bounce mail. */
function automaticMailReason(email: InboundAgentEmail): string | null {
  if (email.autoSubmitted && email.autoSubmitted !== 'no') {
    return 'Automatic replies are not accepted';
  }
  if (email.precedence && BULK_PRECEDENCE.has(email.precedence)) return 'Bulk mail is not accepted';
  if (email.hasListId) return 'Mailing-list mail is not accepted';
  if (!email.envelopeFrom || SYSTEM_SENDER.test(email.envelopeFrom)) {
    return 'Bounces are not accepted';
  }
  return null;
}

/**
 * Loopback replies come from one of this deployment's agent addresses. Anything else, or a
 * burst, is refused before it can overwrite the admin-visible loopback status.
 */
async function receiveLoopback(
  message: InboundEmailMessage,
  env: Env,
  limits: AgentEmailLimits,
  now: Date
): Promise<InboundOutcome> {
  if (!(await withinRateLimit(env, 'agent-email-loopback-inbound', 'all', limits.loopbackPerHour))) {
    return reject(message, 'Too many loopback emails; try again later');
  }
  const email = await readEmail(message, limits, { recipient: 'loopback' });
  if (!email) return reject(message, UNREADABLE);
  const sender = email.from ? parseAgentEmailRecipient(email.from, env.BASE_DOMAIN) : null;
  if (!email.from || sender?.kind !== 'trigger') return reject(message, 'Unknown address');
  await recordLoopbackReceipt(env, {
    from: email.from,
    subject: email.subject,
    autoSubmitted: sanitizeHeaderText(email.autoSubmitted, 40) || null,
    receivedAt: now.toISOString(),
  });
  return { kind: 'loopback' };
}

async function loadEmailTrigger(env: Env, key: string) {
  const db = drizzle(env.DATABASE, { schema });
  const found = await db
    .select({
      trigger: schema.triggers,
      allowedSendersJson: schema.triggerEmailConfigs.allowedSendersJson,
      projectName: schema.projects.name,
    })
    .from(schema.triggerEmailConfigs)
    .innerJoin(schema.triggers, eq(schema.triggers.id, schema.triggerEmailConfigs.triggerId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.triggers.projectId))
    .where(eq(schema.triggerEmailConfigs.addressKey, key))
    .get();
  return found?.trigger.sourceType === 'email' ? { db, ...found } : null;
}

export async function handleInboundAgentEmail(
  message: InboundEmailMessage,
  env: Env,
  deps: InboundDeps = {}
): Promise<InboundOutcome> {
  const now = deps.now?.() ?? new Date();
  if (!isAgentEmailAvailable(env)) return reject(message, 'Agent email is not enabled here');
  const recipient = parseAgentEmailRecipient(message.to, env.BASE_DOMAIN);
  if (!recipient) return reject(message, 'Unknown address');

  const limits = await getAgentEmailLimits(env);
  if (message.rawSize > limits.maxInboundBytes) return reject(message, 'Message is too large');
  if (recipient.kind === 'loopback') return receiveLoopback(message, env, limits, now);

  const found = await loadEmailTrigger(env, recipient.key);
  if (!found) return reject(message, 'Unknown address');
  const { db, trigger } = found;
  const logContext = { triggerId: trigger.id, projectId: trigger.projectId };

  if (
    !(await withinRateLimit(
      env,
      'agent-email-inbound',
      trigger.id,
      limits.inboundPerTriggerPerHour
    ))
  ) {
    log.warn('agent_email.inbound_rate_limited', logContext);
    return reject(message, 'Too many emails to this address; try again later');
  }

  const email = await readEmail(message, limits, logContext);
  if (!email) return reject(message, UNREADABLE);
  const automatic = automaticMailReason(email);
  if (automatic) {
    log.info('agent_email.inbound_rejected', { ...logContext, reason: automatic });
    return reject(message, automatic);
  }
  if (!email.from || !parseAllowedSenders(found.allowedSendersJson).includes(email.from)) {
    log.warn('agent_email.inbound_rejected', { ...logContext, reason: 'sender_not_allowed' });
    return reject(message, 'Sender not allowed');
  }
  if (!email.messageId) return reject(message, 'A Message-ID header is required');

  const address = agentEmailAddress(env.BASE_DOMAIN, recipient.key);
  const claim = await claimDelivery(
    db,
    {
      triggerId: trigger.id,
      projectId: trigger.projectId,
      messageId: email.messageId,
      referencesHeader: email.references.join(' ') || null,
      fromAddress: email.from,
      toAddress: address,
      subject: email.subject,
      rawSize: message.rawSize,
    },
    now,
    limits.processingLeaseSeconds * 1000
  );
  if (claim === 'duplicate') return { kind: 'duplicate' };
  if (claim === 'busy') throw new Error('Delivery of this message is already in progress');
  const { rowId } = claim;

  let submittedExecutionId: string | null = null;
  try {
    const admission = await admitAndSubmitTriggerExecution(
      env,
      {
        trigger,
        eventType: 'email',
        triggeredBy: 'email',
        scheduledAt: now.toISOString(),
        beforeSubmit: async (executionId) => {
          await db
            .update(schema.triggerEmailMessages)
            .set({ triggerExecutionId: executionId, updatedAt: now.toISOString() })
            .where(eq(schema.triggerEmailMessages.id, rowId));
        },
        renderPrompt: (executionId, sequenceNumber) =>
          renderEmailPrompt(
            trigger.promptTemplate,
            buildEmailContext({
              email,
              address,
              receivedAt: now.toISOString(),
              trigger,
              projectName: found.projectName,
              executionId,
              sequenceNumber,
            }),
            limits.maxBodyChars
          ),
      },
      deps.submitter ?? submitTriggeredTask
    );

    if (admission.outcome === 'submitted' || admission.outcome === 'pending') {
      submittedExecutionId = admission.executionId;
      await finishDelivery(db, rowId, 'accepted', now, {
        triggerExecutionId: admission.executionId,
      });
      log.info('agent_email.inbound_accepted', {
        ...logContext,
        executionId: admission.executionId,
        outcome: admission.outcome,
      });
      return { kind: 'accepted', executionId: admission.executionId };
    }
    if (admission.outcome === 'failed') {
      throw new Error(`Trigger submission failed: ${admission.error}`);
    }
    let reason = 'This agent is busy with earlier email; try again later';
    if (admission.outcome === 'inactive') {
      reason =
        admission.reason === 'paused'
          ? 'This agent address is paused'
          : 'This agent address is turned off';
    }
    await finishDelivery(db, rowId, 'rejected', now, { reason: admission.reason });
    log.info('agent_email.inbound_rejected', { ...logContext, reason: admission.outcome });
    return reject(message, reason);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (submittedExecutionId) {
      // The task exists; only recording it failed. Report success: a thrown handler is
      // retried, and the retry must not start this email twice. A later takeover of the row
      // finds the linked task and stops there (inbound-delivery.ts:alreadySubmitted).
      log.error('agent_email.inbound_bookkeeping_failed', {
        ...logContext,
        executionId: submittedExecutionId,
        error: detail,
      });
      return { kind: 'accepted', executionId: submittedExecutionId };
    }
    // Not a reject: setReject is permanent, and this failure may be temporary. Cloudflare does
    // not document whether it redelivers after a thrown handler. Marking the claim failed first
    // lets any redelivery, or a resend of the same Message-ID, run again.
    await finishDelivery(db, rowId, 'failed', now, { reason: detail.slice(0, 500) }).catch(
      () => undefined
    );
    log.error('agent_email.inbound_failed', { ...logContext, error: detail });
    throw error;
  }
}
