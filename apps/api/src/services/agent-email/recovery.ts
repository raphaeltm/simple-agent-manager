/**
 * Recovery sweep for stored inbound agent email (5-minute cron). Retries emails whose agent
 * could not be started, takes over attempts that crashed (lease expired), and gives up on
 * emails that used every attempt. Bounded per run by `agentEmail.recoveryBatchSize`; each
 * attempt is a few D1 statements plus one task submission, so a run costs at most the batch
 * size times one submission, and it runs in the background like the GitHub trigger recovery.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { notifyFailedSweeps } from '../../scheduled/failed-sweep-notifications';
import { agentEmailAddress, isAgentEmailAvailable } from './address';
import {
  type ClaimedDelivery,
  claimForRetry,
  dueDeliveries,
  finishDelivery,
  giveUpExhausted,
} from './inbound-delivery';
import { attemptDelivery, type AttemptOptions, type DeliveryContext } from './inbound-process';
import { type AgentEmailLimits, getAgentEmailLimits } from './settings';

type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface AgentEmailRecoveryStats {
  selected: number;
  accepted: number;
  retrying: number;
  refused: number;
  gaveUp: number;
  superseded: number;
  skipped: number;
}

async function loadDeliveryContext(
  env: Env,
  db: Database,
  delivery: ClaimedDelivery,
  limits: AgentEmailLimits
): Promise<DeliveryContext | null> {
  const found = await db
    .select({
      trigger: schema.triggers,
      addressKey: schema.triggerEmailConfigs.addressKey,
      projectName: schema.projects.name,
    })
    .from(schema.triggers)
    .innerJoin(
      schema.triggerEmailConfigs,
      eq(schema.triggerEmailConfigs.triggerId, schema.triggers.id)
    )
    .innerJoin(schema.projects, eq(schema.projects.id, schema.triggers.projectId))
    .where(
      and(
        eq(schema.triggers.id, delivery.triggerId),
        eq(schema.triggers.projectId, delivery.projectId)
      )
    )
    .get();
  if (found?.trigger.sourceType !== 'email') return null;
  return {
    db,
    trigger: found.trigger,
    projectName: found.projectName,
    address: agentEmailAddress(env.BASE_DOMAIN, found.addressKey),
    limits,
  };
}

async function alertGaveUp(env: Env): Promise<void> {
  try {
    await notifyFailedSweeps(env, ['agent_email_delivery_gave_up']);
  } catch {
    log.error('agent_email.gave_up_alert_failed', {});
  }
}

async function retryOne(
  env: Env,
  db: Database,
  rowId: string,
  limits: AgentEmailLimits,
  options: Omit<AttemptOptions, 'refuseBusy'>,
  stats: AgentEmailRecoveryStats
): Promise<void> {
  const clock = options.now ?? (() => new Date());
  const delivery = await claimForRetry(
    db,
    rowId,
    clock(),
    limits.processingLeaseSeconds * 1000,
    limits.maxDeliveryAttempts
  );
  if (!delivery) {
    stats.skipped += 1;
    return;
  }
  const context = await loadDeliveryContext(env, db, delivery, limits);
  if (!context) {
    await finishDelivery(db, delivery, 'rejected', clock(), 'The email trigger no longer exists');
    stats.refused += 1;
    return;
  }
  const outcome = await attemptDelivery(env, context, delivery, { ...options, refuseBusy: false });
  if (outcome.kind === 'accepted') stats.accepted += 1;
  else if (outcome.kind === 'retrying') stats.retrying += 1;
  else if (outcome.kind === 'refused') stats.refused += 1;
  else if (outcome.kind === 'gave_up') stats.gaveUp += 1;
  else stats.superseded += 1;
}

export async function runAgentEmailRecovery(
  env: Env,
  waitUntil?: (work: Promise<unknown>) => void,
  options: Omit<AttemptOptions, 'refuseBusy'> = {}
): Promise<AgentEmailRecoveryStats | { skipped: 'agent_email_off' }> {
  if (!isAgentEmailAvailable(env)) return { skipped: 'agent_email_off' };
  const clock = options.now ?? (() => new Date());
  const db = drizzle(env.DATABASE, { schema });
  const limits = await getAgentEmailLimits(env);
  const gaveUpStale = await giveUpExhausted(
    db,
    clock(),
    limits.maxDeliveryAttempts,
    limits.recoveryBatchSize
  );
  const due = await dueDeliveries(
    db,
    clock(),
    limits.maxDeliveryAttempts,
    limits.recoveryBatchSize
  );
  const stats: AgentEmailRecoveryStats = {
    selected: due.length,
    accepted: 0,
    retrying: 0,
    refused: 0,
    gaveUp: gaveUpStale,
    superseded: 0,
    skipped: 0,
  };
  const run = async () => {
    for (const rowId of due) {
      // One email's failure must not stop the others (rule 53).
      try {
        await retryOne(env, db, rowId, limits, options, stats);
      } catch (error) {
        log.warn('agent_email.recovery_item_failed', {
          rowId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (stats.gaveUp > 0) await alertGaveUp(env);
    log.info('agent_email.recovery_sweep', { ...stats });
    return stats;
  };
  if (waitUntil) {
    // Like GitHub trigger recovery: task submission should not hold up the other sweeps.
    waitUntil(run());
    return stats;
  }
  return run();
}
