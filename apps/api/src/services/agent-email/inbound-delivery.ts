/**
 * Durable intake for inbound agent email (trigger_email_messages, direction 'inbound').
 *
 * Before SMTP is answered, an email is stored with what its prompt needs and a stable
 * execution id. From then on SAM owns it: an attempt that crashes or fails is retried from
 * this row (agent-email/recovery.ts), every attempt resumes the same trigger execution
 * (task submission is idempotent per execution id), and an attempt's writes are fenced by its
 * lease token, so a slow attempt that lost its lease cannot overwrite the attempt that took
 * over. That fence covers this row and admission's writes to the execution (`emailLease` in
 * trigger-admission.ts). Task creation is fenced by the email's end state instead: once an
 * email is rejected, its execution can no longer gain a task (reserved-task-submission-storage.ts).
 */
import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
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
    await closeDelivery(db, delivery, heldBy(delivery), now, 'The stored email could not be read');
    return null;
  }
  return { ...delivery, stored };
}

type Owned = Pick<ClaimedDelivery, 'rowId' | 'leaseToken'>;

function ownedBy(delivery: Owned) {
  return and(eq(messages.id, delivery.rowId), eq(messages.leaseToken, delivery.leaseToken));
}

/** The attempt holding this lease may end the email. */
export function heldBy(delivery: Owned): SQL {
  return eq(messages.leaseToken, delivery.leaseToken);
}

/** The sweep may end an email that used every attempt and is not being worked on. */
function exhausted(maxAttempts: number, nowIso: string): SQL {
  return and(gte(messages.attempts, maxAttempts), retryableNow(nowIso)) as SQL;
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

function closedFields(nowIso: string) {
  return {
    payloadJson: null,
    leaseToken: null,
    leaseExpiresAt: null,
    availableAt: null,
    updatedAt: nowIso,
  };
}

/** Record that the agent started and drop the stored email. A no-op for an attempt that lost its lease. */
export async function acceptDelivery(db: Database, delivery: Owned, now: Date): Promise<boolean> {
  const updated = await db
    .update(messages)
    .set({ status: 'accepted', reason: null, ...closedFields(now.toISOString()) })
    .where(ownedBy(delivery))
    .returning({ id: messages.id });
  return updated.length > 0;
}

export type ClosedDelivery = 'rejected' | 'accepted' | 'unchanged';

/**
 * End a stored email that will not be (re)tried, in one batch. A submission can succeed after
 * its caller saw an error, so an email whose execution already has a task is accepted, never
 * rejected. Otherwise the email is rejected, and an execution its attempts reserved but never
 * started is failed so it stops holding a run slot. A task insert racing this batch either
 * commits first (the email is then accepted) or sees the rejection and is refused.
 * `unchanged` means `ownership` no longer held: another attempt or sweep ended it first.
 */
export async function closeDelivery(
  db: Database,
  delivery: Pick<ClaimedDelivery, 'rowId'>,
  ownership: SQL,
  now: Date,
  reason: string
): Promise<ClosedDelivery> {
  const nowIso = now.toISOString();
  const hasTask = sql`EXISTS (SELECT 1 FROM tasks t WHERE t.trigger_execution_id = ${messages.triggerExecutionId})`;
  const [rejected, accepted] = await db.batch([
    db
      .update(messages)
      .set({ status: 'rejected', reason, ...closedFields(nowIso) })
      .where(and(eq(messages.id, delivery.rowId), ownership, not(hasTask)))
      .returning({ id: messages.id }),
    db
      .update(messages)
      .set({ status: 'accepted', reason: null, ...closedFields(nowIso) })
      .where(and(eq(messages.id, delivery.rowId), ownership, hasTask))
      .returning({ id: messages.id }),
    db
      .update(schema.triggerExecutions)
      .set({ status: 'failed', errorMessage: reason, completedAt: nowIso })
      .where(
        and(
          eq(schema.triggerExecutions.status, 'queued'),
          isNull(schema.triggerExecutions.taskId),
          sql`${schema.triggerExecutions.id} = (SELECT trigger_execution_id FROM trigger_email_messages
                WHERE id = ${delivery.rowId} AND status = 'rejected')`
        )
      ),
  ]);
  if (rejected.length > 0) return 'rejected';
  if (accepted.length > 0) return 'accepted';
  return 'unchanged';
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
 * End stored emails that used every attempt and are not being worked on, so no row stays
 * retryable forever: each is given up, or accepted if its task turns out to exist.
 */
export async function closeExhausted(
  db: Database,
  now: Date,
  maxAttempts: number,
  limit: number
): Promise<{ gaveUp: number; accepted: number }> {
  const nowIso = now.toISOString();
  const stale = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.direction, 'inbound'),
        isNotNull(messages.payloadJson),
        exhausted(maxAttempts, nowIso)
      )
    )
    .limit(limit)
    .all();
  const counts = { gaveUp: 0, accepted: 0 };
  for (const { id } of stale) {
    const closed = await closeDelivery(
      db,
      { rowId: id },
      exhausted(maxAttempts, nowIso),
      now,
      `Gave up after ${maxAttempts} attempts to start the agent`
    );
    if (closed === 'rejected') counts.gaveUp += 1;
    if (closed === 'accepted') counts.accepted += 1;
  }
  return counts;
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
