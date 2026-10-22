/**
 * Inbound email delivery claims (trigger_email_messages, direction 'inbound').
 *
 * One row per (trigger, Message-ID). A delivery attempt holds a lease while it runs. A retried
 * or resent delivery may take the row over only after a failure or an expired lease, and never
 * starts a second task for an email whose task already exists.
 */
import { and, eq, lt, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { ulid } from '../../lib/ulid';

type Database = ReturnType<typeof drizzle<typeof schema>>;

export type DeliveryClaim = { rowId: string } | 'duplicate' | 'busy';

type ClaimValues = Omit<
  typeof schema.triggerEmailMessages.$inferInsert,
  'id' | 'status' | 'direction'
> & { messageId: string };

function sameDelivery(values: ClaimValues) {
  return and(
    eq(schema.triggerEmailMessages.triggerId, values.triggerId),
    eq(schema.triggerEmailMessages.direction, 'inbound'),
    eq(schema.triggerEmailMessages.messageId, values.messageId)
  );
}

export async function finishDelivery(
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

/**
 * A row still processing, or taken over after a crash, may belong to an email whose task was
 * already submitted: `beforeSubmit` links the execution before submission starts. If that
 * execution has a task, the email was delivered; record it and report a duplicate instead of
 * submitting again or asking the sender to retry.
 */
async function alreadySubmitted(db: Database, rowId: string, now: Date): Promise<boolean> {
  const row = await db
    .select({ executionId: schema.triggerEmailMessages.triggerExecutionId })
    .from(schema.triggerEmailMessages)
    .where(eq(schema.triggerEmailMessages.id, rowId))
    .get();
  if (!row?.executionId) return false;
  const task = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.triggerExecutionId, row.executionId))
    .get();
  if (!task) return false;
  await finishDelivery(db, rowId, 'accepted', now, { triggerExecutionId: row.executionId });
  return true;
}

export async function claimDelivery(
  db: Database,
  values: ClaimValues,
  now: Date,
  leaseMs: number
): Promise<DeliveryClaim> {
  const id = ulid();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const inserted = await db
    .insert(schema.triggerEmailMessages)
    .values({ ...values, id, direction: 'inbound', status: 'processing', leaseExpiresAt })
    .onConflictDoNothing()
    .returning({ id: schema.triggerEmailMessages.id });
  if (inserted.length > 0) return { rowId: id };

  const reclaimed = await db
    .update(schema.triggerEmailMessages)
    .set({ status: 'processing', leaseExpiresAt, updatedAt: now.toISOString() })
    .where(
      and(
        sameDelivery(values),
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
  const takenOver = reclaimed[0]?.id;
  if (takenOver) {
    return (await alreadySubmitted(db, takenOver, now)) ? 'duplicate' : { rowId: takenOver };
  }

  const existing = await db
    .select({ id: schema.triggerEmailMessages.id, status: schema.triggerEmailMessages.status })
    .from(schema.triggerEmailMessages)
    .where(sameDelivery(values))
    .get();
  if (existing?.status !== 'processing') return 'duplicate';
  // A live lease whose task already exists was delivered; only its bookkeeping is pending.
  return (await alreadySubmitted(db, existing.id, now)) ? 'duplicate' : 'busy';
}
