/**
 * Inbound agent email: the logic behind the API Worker's `email()` handler.
 *
 * Mail to `agent+<key>@agents.<BASE_DOMAIN>` starts the email trigger that owns `<key>`
 * through the shared trigger admission path. Every refusal is an SMTP-time reject, so a
 * forged sender gets no backscatter. Workers cannot see SPF/DKIM/DMARC verdicts
 * (cloudflare/workerd#6740); the unguessable address plus the sender allowlist are the
 * controls. The operator accepted reliance on Cloudflare's checks on 2026-10-23;
 * the From allowlist is not independent sender authentication.
 *
 * An email that passes the checks is stored before SMTP is answered (inbound-delivery.ts).
 * After that the handler never throws: a failed or crashed attempt is retried by SAM from
 * storage (recovery.ts), not by the sender's server. The only failure left to the sender is
 * the store itself failing, before SAM has taken responsibility for the email.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  checkRateLimit,
  createRateLimitKey,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
} from '../../middleware/rate-limit';
import { agentEmailAddress, parseAgentEmailRecipient } from './address';
import { sanitizeHeaderText } from './headers';
import { recordIntake } from './inbound-delivery';
import { type InboundAgentEmail, parseInboundEmail } from './inbound-message';
import { attemptDelivery, type AttemptOptions } from './inbound-process';
import { recordLoopbackReceipt } from './loopback';
import { type AgentEmailLimits, getAgentEmailLimits } from './settings';
import { isAgentEmailOn } from './setup-state';
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
  /** Stored, and SAM will retry starting the agent. */
  | { kind: 'queued' }
  | { kind: 'duplicate' }
  | { kind: 'loopback' }
  | { kind: 'rejected'; reason: string };

export type InboundDeps = Omit<AttemptOptions, 'refuseBusy'>;

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);
const SYSTEM_SENDER = /^(mailer-daemon|postmaster)@/i;
const UNREADABLE = 'This email could not be read';

function reject(message: InboundEmailMessage, reason: string): InboundOutcome {
  message.setReject(reason);
  return { kind: 'rejected', reason };
}

/** The window is fixed at one hour: the limits are the `agentEmail.*PerHour` settings. */
async function withinRateLimit(env: Env, scope: string, id: string, limit: number) {
  const key = createRateLimitKey(scope, id, getCurrentWindowStart(DEFAULT_WINDOW_SECONDS));
  return (await checkRateLimit(env.KV, key, limit, DEFAULT_WINDOW_SECONDS)).allowed;
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
  if (
    !(await withinRateLimit(env, 'agent-email-loopback-inbound', 'all', limits.loopbackPerHour))
  ) {
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
    inReplyTo: email.inReplyTo,
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
  if (!(await isAgentEmailOn(env))) return reject(message, 'Agent email is not enabled here');
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
  // The one write that may still fail the delivery back to the sender: until it commits,
  // nothing about this email exists in SAM.
  const intake = await recordIntake(
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
    { email, receivedAt: now.toISOString() },
    now,
    limits.processingLeaseSeconds * 1000
  );
  if (intake.kind === 'duplicate') return { kind: 'duplicate' };

  const outcome = await attemptDelivery(
    env,
    { db, trigger, projectName: found.projectName, address, limits },
    intake.delivery,
    { ...deps, refuseBusy: true }
  );
  switch (outcome.kind) {
    case 'accepted':
      return { kind: 'accepted', executionId: outcome.executionId };
    case 'refused':
      return reject(message, outcome.reason);
    case 'gave_up':
      return reject(message, 'This agent could not be started; try again later');
    case 'retrying':
    case 'superseded':
      return { kind: 'queued' };
  }
}
