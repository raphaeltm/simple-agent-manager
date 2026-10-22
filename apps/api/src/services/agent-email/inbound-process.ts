/**
 * One attempt to start the agent for a stored inbound email. The email() handler makes the
 * first attempt while the sender's server waits; the recovery sweep makes every later one.
 * Each attempt resumes the email's own trigger execution, so a retry can never reserve a
 * second run slot or start a second task for the same email.
 */
import type { drizzle } from 'drizzle-orm/d1';

import type * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { admitAndSubmitTriggerExecution } from '../trigger-admission';
import { submitTriggeredTask } from '../trigger-submit';
import { buildEmailContext, renderEmailPrompt } from './context';
import {
  type ClaimedDelivery,
  finishDelivery,
  ownsLease,
  retryDelayMs,
  scheduleRetry,
} from './inbound-delivery';
import type { AgentEmailLimits } from './settings';

type Database = ReturnType<typeof drizzle<typeof schema>>;

export type DeliveryOutcome =
  | { kind: 'accepted'; executionId: string }
  /** Admission refused it for good (paused, off, or busy on the first attempt). */
  | { kind: 'refused'; reason: string }
  /** Stored for a later retry by the recovery sweep. */
  | { kind: 'retrying' }
  /** Every attempt failed; the email was given up on. */
  | { kind: 'gave_up' }
  /** Another attempt took the email over; this one wrote nothing. */
  | { kind: 'superseded' };

export interface DeliveryContext {
  db: Database;
  trigger: schema.TriggerRow;
  projectName: string;
  address: string;
  limits: AgentEmailLimits;
}

export interface AttemptOptions {
  submitter?: Parameters<typeof admitAndSubmitTriggerExecution>[2];
  now?: () => Date;
  /**
   * The first attempt refuses mail while the automation is busy, so the sender's server
   * reports it. Retries keep it instead: the first attempt already accepted the email.
   */
  refuseBusy: boolean;
}

const BUSY = 'This agent is busy with earlier email; try again later';

async function retryOrGiveUp(
  context: DeliveryContext,
  delivery: ClaimedDelivery,
  now: Date,
  reason: string
): Promise<DeliveryOutcome> {
  const logContext = {
    triggerId: delivery.triggerId,
    projectId: delivery.projectId,
    executionId: delivery.executionId,
    attempt: delivery.attempts,
  };
  if (delivery.attempts >= context.limits.maxDeliveryAttempts) {
    await finishDelivery(
      context.db,
      delivery,
      'rejected',
      now,
      `Gave up after ${delivery.attempts} attempts: ${reason}`.slice(0, 500)
    ).catch(() => false);
    log.error('agent_email.delivery_gave_up', { ...logContext, reason });
    return { kind: 'gave_up' };
  }
  const delayMs = retryDelayMs(delivery.attempts, context.limits);
  // If this write fails too, the lease expires and the sweep retries the row anyway.
  await scheduleRetry(context.db, delivery, now, delayMs, reason.slice(0, 500)).catch(() => false);
  log.warn('agent_email.delivery_retry_scheduled', { ...logContext, delayMs, reason });
  return { kind: 'retrying' };
}

export async function attemptDelivery(
  env: Env,
  context: DeliveryContext,
  delivery: ClaimedDelivery,
  options: AttemptOptions
): Promise<DeliveryOutcome> {
  const clock = options.now ?? (() => new Date());
  const { db, trigger, limits } = context;
  const { email, receivedAt } = delivery.stored;
  const logContext = {
    triggerId: trigger.id,
    projectId: trigger.projectId,
    executionId: delivery.executionId,
    attempt: delivery.attempts,
  };
  try {
    const admission = await admitAndSubmitTriggerExecution(
      env,
      {
        trigger,
        eventType: 'email',
        triggeredBy: 'email',
        scheduledAt: receivedAt,
        executionId: delivery.executionId,
        // A slow attempt that lost its lease stops before submitting. If it already passed
        // this check, submission is idempotent per execution id, so both converge on one task.
        beforeSubmit: async () => {
          if (!(await ownsLease(db, delivery, clock()))) {
            throw new Error('Another attempt took over this email');
          }
        },
        renderPrompt: (executionId, sequenceNumber) =>
          renderEmailPrompt(
            trigger.promptTemplate,
            buildEmailContext({
              email,
              address: context.address,
              receivedAt,
              trigger,
              projectName: context.projectName,
              executionId,
              sequenceNumber,
            }),
            limits.maxBodyChars
          ),
      },
      options.submitter ?? submitTriggeredTask
    );

    if (admission.outcome === 'submitted' || admission.outcome === 'pending') {
      // Replies find the email by its execution id, not by this status, so a failed write here
      // only delays the bookkeeping: the sweep repairs it once the lease expires.
      const recorded = await finishDelivery(db, delivery, 'accepted', clock()).catch(
        (error: unknown) => {
          log.error('agent_email.acceptance_unrecorded', {
            ...logContext,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      );
      log.info('agent_email.inbound_accepted', {
        ...logContext,
        outcome: admission.outcome,
        recorded,
      });
      return { kind: 'accepted', executionId: admission.executionId };
    }
    if (admission.outcome === 'inactive') {
      const reason =
        admission.reason === 'paused'
          ? 'This agent address is paused'
          : 'This agent address is turned off';
      await finishDelivery(db, delivery, 'rejected', clock(), reason);
      log.info('agent_email.inbound_rejected', { ...logContext, reason: admission.reason });
      return { kind: 'refused', reason };
    }
    if (admission.outcome === 'skipped') {
      if (!options.refuseBusy) return retryOrGiveUp(context, delivery, clock(), BUSY);
      await finishDelivery(db, delivery, 'rejected', clock(), admission.reason);
      log.info('agent_email.inbound_rejected', { ...logContext, reason: admission.reason });
      return { kind: 'refused', reason: BUSY };
    }
    if (!(await ownsLease(db, delivery, clock()))) {
      log.info('agent_email.attempt_superseded', logContext);
      return { kind: 'superseded' };
    }
    return retryOrGiveUp(context, delivery, clock(), admission.error);
  } catch (error) {
    // Storage failed mid-attempt. The row is still this attempt's until its lease expires,
    // and the sweep retries it then, so nothing is lost by not recording more here.
    log.error('agent_email.attempt_failed', {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'retrying' };
  }
}
