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
import { and, eq, lt, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
} from '../../middleware/rate-limit';
import { admitAndSubmitTriggerExecution } from '../trigger-admission';
import { submitTriggeredTask } from '../trigger-submit';
import { agentEmailAddress, isAgentEmailAvailable, parseAgentEmailRecipient } from './address';
import { buildEmailContext, renderEmailPrompt } from './context';
import { type InboundAgentEmail, parseInboundEmail } from './inbound-message';
import { recordLoopbackReceipt } from './loopback';
import { type AgentEmailLimits, getAgentEmailLimits } from './settings';
import { parseAllowedSenders } from './trigger-config';

type Database = ReturnType<typeof drizzle<typeof schema>>;

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

function reject(message: InboundEmailMessage, reason: string): InboundOutcome {
  message.setReject(reason);
  return { kind: 'rejected', reason };
}

async function loadEmailTrigger(db: Database, key: string) {
  return db
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
}

/** Loop guards: never start an agent from automatic, bulk, or bounce mail. */
function automaticMailReason(email: InboundAgentEmail): string | null {
  if (email.autoSubmitted && email.autoSubmitted !== 'no')
    return 'Automatic replies are not accepted';
  if (email.precedence && BULK_PRECEDENCE.has(email.precedence)) return 'Bulk mail is not accepted';
  if (email.hasListId) return 'Mailing-list mail is not accepted';
  if (!email.envelopeFrom || SYSTEM_SENDER.test(email.envelopeFrom))
    return 'Bounces are not accepted';
  return null;
}

/**
 * Claim the (trigger, Message-ID) delivery. Returns the row id to process, 'duplicate' for a
 * message already accepted or refused, or 'busy' while another attempt holds a live lease.
 */
async function claimDelivery(
  db: Database,
  values: Omit<typeof schema.triggerEmailMessages.$inferInsert, 'id' | 'status' | 'direction'>,
  now: Date,
  leaseMs: number
): Promise<string | 'duplicate' | 'busy'> {
  const id = ulid();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const inserted = await db
    .insert(schema.triggerEmailMessages)
    .values({ ...values, id, direction: 'inbound', status: 'processing', leaseExpiresAt })
    .onConflictDoNothing()
    .returning({ id: schema.triggerEmailMessages.id });
  if (inserted.length > 0) return id;

  const reclaimed = await db
    .update(schema.triggerEmailMessages)
    .set({ status: 'processing', leaseExpiresAt, updatedAt: now.toISOString() })
    .where(
      and(
        eq(schema.triggerEmailMessages.triggerId, values.triggerId),
        eq(schema.triggerEmailMessages.direction, 'inbound'),
        eq(schema.triggerEmailMessages.messageId, values.messageId ?? ''),
        or(
          eq(schema.triggerEmailMessages.status, 'failed'),
          and(
            eq(schema.triggerEmailMessages.status, 'processing'),
            lt(schema.triggerEmailMessages.leaseExpiresAt, now.toISOString())
          )
        )
      )
    )
    .returning({ id: schema.triggerEmailMessages.id });
  if (reclaimed[0]) return reclaimed[0].id;

  const existing = await db
    .select({ status: schema.triggerEmailMessages.status })
    .from(schema.triggerEmailMessages)
    .where(
      and(
        eq(schema.triggerEmailMessages.triggerId, values.triggerId),
        eq(schema.triggerEmailMessages.direction, 'inbound'),
        eq(schema.triggerEmailMessages.messageId, values.messageId ?? '')
      )
    )
    .get();
  return existing?.status === 'processing' ? 'busy' : 'duplicate';
}

async function finishDelivery(
  db: Database,
  rowId: string,
  status: 'accepted' | 'rejected' | 'failed',
  now: Date,
  extra: { reason?: string; triggerExecutionId?: string } = {}
): Promise<void> {
  await db
    .update(schema.triggerEmailMessages)
    .set({
      status,
      reason: extra.reason ?? null,
      ...(extra.triggerExecutionId ? { triggerExecutionId: extra.triggerExecutionId } : {}),
      leaseExpiresAt: null,
      updatedAt: now.toISOString(),
    })
    .where(eq(schema.triggerEmailMessages.id, rowId));
}

async function withinRateLimit(env: Env, triggerId: string, limits: AgentEmailLimits) {
  const key = createRateLimitKey(
    'agent-email-inbound',
    triggerId,
    getCurrentWindowStart(RATE_WINDOW_SECONDS)
  );
  const result = await checkRateLimit(
    env.KV,
    key,
    limits.inboundPerTriggerPerHour,
    RATE_WINDOW_SECONDS
  );
  return result.allowed;
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

  if (recipient.kind === 'loopback') {
    const email = await parseInboundEmail(message.raw, message, limits.maxBodyChars);
    await recordLoopbackReceipt(env, {
      from: email.from ?? email.envelopeFrom,
      subject: email.subject,
      autoSubmitted: email.autoSubmitted,
      receivedAt: now.toISOString(),
    });
    return { kind: 'loopback' };
  }

  const db = drizzle(env.DATABASE, { schema });
  const found = await loadEmailTrigger(db, recipient.key);
  if (!found || found.trigger.sourceType !== 'email') return reject(message, 'Unknown address');
  const { trigger } = found;
  const logContext = { triggerId: trigger.id, projectId: trigger.projectId };

  if (!(await withinRateLimit(env, trigger.id, limits))) {
    log.warn('agent_email.inbound_rate_limited', logContext);
    return reject(message, 'Too many emails to this address; try again later');
  }

  const email = await parseInboundEmail(message.raw, message, limits.maxBodyChars);
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
            .where(eq(schema.triggerEmailMessages.id, claim));
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
      await finishDelivery(db, claim, 'accepted', now, {
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
    await finishDelivery(db, claim, 'rejected', now, { reason: admission.reason });
    log.info('agent_email.inbound_rejected', { ...logContext, reason: admission.outcome });
    return reject(message, reason);
  } catch (error) {
    // Email Routing retries a Worker call that throws (a few attempts). Marking the claim
    // failed first lets that retry, or a later resend of the same Message-ID, run again.
    await finishDelivery(db, claim, 'failed', now, {
      reason: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    }).catch(() => undefined);
    log.error('agent_email.inbound_failed', {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
