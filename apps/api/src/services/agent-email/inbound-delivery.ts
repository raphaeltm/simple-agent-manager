/**
 * Durable intake for inbound agent email (trigger_email_messages, direction 'inbound').
 *
 * Before SMTP is answered, an email is stored with what its prompt needs and a stable
 * execution id. From then on SAM owns it: an attempt that crashes or fails is retried from
 * this row (agent-email/recovery.ts), every attempt resumes the same trigger execution
 * (task submission is idempotent per execution id), and an attempt's writes to the row are
 * fenced by its lease token, so a slow attempt that lost its lease cannot overwrite the
 * attempt that took over.
 */
import { and, asc, eq, gt, gte, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import { ulid } from '../../lib/ulid';
import type { InboundAgentEmail } from './inbound-message';

type Database = ReturnType<typeof drizzle<typeof schema>>;
const messages = schema.triggerEmailMessages;

/** What an attempt needs to render the prompt; kept until the email is accepted or given up. */
export interface StoredInboundEmail {
  email: InboundAgentEmail;
  receivedAt: string;
}

const StoredInboundEmailSchema = v.object({
  receivedAt: v.string(),
  email: v.object({
    envelopeFrom: v.string(),
    envelopeTo: v.string(),
    from: v.nullable(v.string()),
    fromName: v.string(),
    subject: v.string(),
    messageId: v.nullable(v.string()),
    inReplyTo: v.nullable(v.string()),
    references: v.array(v.string()),
    text: v.string(),
    textTruncated: v.boolean(),
    attachments: v.array(
      v.object({ filename: v.string(), mimeType: v.string(), size: v.number() })
    ),
    autoSubmitted: v.nullable(v.string()),
    precedence: v.nullable(v.string()),
    hasListId: v.boolean(),
  }),
});

export interface ClaimedDelivery {
  rowId: string;
  triggerId: string;
  projectId: string;
  executionId: string;
  leaseToken: string;
  /** Attempts so far, including the one holding the lease. */
  attempts: number;
  stored: StoredInboundEmail;
}

export type IntakeResult = { kind: 'new'; delivery: ClaimedDelivery } | { kind: 'duplicate' };

export interface IntakeValues {
  triggerId: string;
  projectId: string;
  messageId: string;
  referencesHeader: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string;
  rawSize: number;
}

function parseStored(payloadJson: string | null): StoredInboundEmail | null {
  if (!payloadJson) return null;
  try {
    const result = v.safeParse(StoredInboundEmailSchema, JSON.parse(payloadJson) as unknown);
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

/**
 * Store a new inbound email, claimed by the calling attempt. Any existing row for the same
 * (trigger, Message-ID) means SAM already owns this email, in whatever state, so a later copy
 * is a duplicate: a copy that arrives while the first is still being delivered no longer needs
 * the sender to retry, because the stored row is retried by SAM if that attempt fails.
 */
export async function recordIntake(
  db: Database,
  values: IntakeValues,
  stored: StoredInboundEmail,
  now: Date,
  leaseMs: number
): Promise<IntakeResult> {
  const delivery: ClaimedDelivery = {
    rowId: ulid(),
    triggerId: values.triggerId,
    projectId: values.projectId,
    executionId: ulid(),
    leaseToken: ulid(),
    attempts: 1,
    stored,
  };
  const inserted = await db
    .insert(messages)
    .values({
      ...values,
      id: delivery.rowId,
      direction: 'inbound',
      status: 'processing',
      triggerExecutionId: delivery.executionId,
      payloadJson: JSON.stringify(stored),
      attempts: 1,
      leaseToken: delivery.leaseToken,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });
  return inserted.length > 0 ? { kind: 'new', delivery } : { kind: 'duplicate' };
}

/** A stored email a retry may run now: due after a failure, or abandoned by a crashed attempt. */
function retryableNow(nowIso: string) {
  return or(
    and(eq(messages.status, 'failed'), lte(messages.availableAt, nowIso)),
    and(eq(messages.status, 'processing'), lte(messages.leaseExpiresAt, nowIso))
  );
}

/** Take a retryable stored email for one attempt, or null when it is not retryable now. */
export async function claimForRetry(
  db: Database,
  rowId: string,
  now: Date,
  leaseMs: number,
  maxAttempts: number
): Promise<ClaimedDelivery | null> {
  const leaseToken = ulid();
  const nowIso = now.toISOString();
  const [row] = await db
    .update(messages)
    .set({
      status: 'processing',
      attempts: sql`${messages.attempts} + 1`,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      availableAt: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(messages.id, rowId),
        eq(messages.direction, 'inbound'),
        isNotNull(messages.payloadJson),
        isNotNull(messages.triggerExecutionId),
        lt(messages.attempts, maxAttempts),
        retryableNow(nowIso)
      )
    )
    .returning();
  if (!row?.triggerExecutionId) return null;
  const delivery = {
    rowId: row.id,
    triggerId: row.triggerId,
    projectId: row.projectId,
    executionId: row.triggerExecutionId,
    leaseToken,
    attempts: row.attempts,
  };
  const stored = parseStored(row.payloadJson);
  if (!stored) {
    await finishDelivery(db, delivery, 'rejected', now, 'The stored email could not be read');
    return null;
  }
  return { ...delivery, stored };
}

type Owned = Pick<ClaimedDelivery, 'rowId' | 'leaseToken'>;

function ownedBy(delivery: Owned) {
  return and(eq(messages.id, delivery.rowId), eq(messages.leaseToken, delivery.leaseToken));
}

/** Whether this attempt still owns the row; checked before submitting a task. */
export async function ownsLease(db: Database, delivery: Owned, now: Date): Promise<boolean> {
  const row = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        ownedBy(delivery),
        eq(messages.status, 'processing'),
        gt(messages.leaseExpiresAt, now.toISOString())
      )
    )
    .get();
  return Boolean(row);
}

/** Record the final outcome and drop the stored email. A no-op for an attempt that lost its lease. */
export async function finishDelivery(
  db: Database,
  delivery: Owned,
  status: 'accepted' | 'rejected',
  now: Date,
  reason?: string
): Promise<boolean> {
  const updated = await db
    .update(messages)
    .set({
      status,
      reason: reason ?? null,
      payloadJson: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: null,
      updatedAt: now.toISOString(),
    })
    .where(ownedBy(delivery))
    .returning({ id: messages.id });
  return updated.length > 0;
}

/** Release the row for a later retry. A no-op for an attempt that lost its lease. */
export async function scheduleRetry(
  db: Database,
  delivery: Owned,
  now: Date,
  delayMs: number,
  reason: string
): Promise<boolean> {
  const updated = await db
    .update(messages)
    .set({
      status: 'failed',
      reason,
      availableAt: new Date(now.getTime() + delayMs).toISOString(),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now.toISOString(),
    })
    .where(ownedBy(delivery))
    .returning({ id: messages.id });
  return updated.length > 0;
}

/** Exponential backoff for the next retry after `attempts` attempts, capped. */
export function retryDelayMs(
  attempts: number,
  limits: { retryBaseSeconds: number; retryMaxSeconds: number }
): number {
  const seconds = limits.retryBaseSeconds * 2 ** Math.min(Math.max(attempts - 1, 0), 30);
  return Math.min(seconds, limits.retryMaxSeconds) * 1000;
}

/**
 * Give up on stored emails that used every attempt and are not being worked on, so no row
 * stays retryable forever. Returns how many were given up.
 */
export async function giveUpExhausted(
  db: Database,
  now: Date,
  maxAttempts: number,
  limit: number
): Promise<number> {
  const nowIso = now.toISOString();
  const stale = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.direction, 'inbound'),
        isNotNull(messages.payloadJson),
        gte(messages.attempts, maxAttempts),
        retryableNow(nowIso)
      )
    )
    .limit(limit)
    .all();
  let gaveUp = 0;
  for (const { id } of stale) {
    const updated = await db
      .update(messages)
      .set({
        status: 'rejected',
        reason: `Gave up after ${maxAttempts} attempts to start the agent`,
        payloadJson: null,
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: null,
        updatedAt: nowIso,
      })
      .where(and(eq(messages.id, id), gte(messages.attempts, maxAttempts), retryableNow(nowIso)))
      .returning({ id: messages.id });
    gaveUp += updated.length;
  }
  return gaveUp;
}

/** Stored emails a retry may run now, oldest first. */
export async function dueDeliveries(
  db: Database,
  now: Date,
  maxAttempts: number,
  limit: number
): Promise<string[]> {
  const nowIso = now.toISOString();
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.direction, 'inbound'),
        isNotNull(messages.payloadJson),
        lt(messages.attempts, maxAttempts),
        retryableNow(nowIso)
      )
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit)
    .all();
  return rows.map((row) => row.id);
}
