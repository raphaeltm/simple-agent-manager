import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { classifySessionRecoveryRefusal } from './session-recovery-refusals';
import type { Db } from './session-recovery-task-guard';
import { sessionLifecycleError } from './session-snapshots';

export type SessionRecoveryResult =
  { status: 'waking'; taskId: string } | { status: 'unavailable'; reason: string };

/** Record why a wake was refused (or log why it was deferred) and return the refusal. */
export async function recordSessionRecoveryRefusal(
  db: Db,
  env: Env,
  chatSessionId: string,
  reason: string,
  detail?: string | null
): Promise<SessionRecoveryResult> {
  const classification = classifySessionRecoveryRefusal(reason);
  if (classification.action === 'report') {
    await db
      .update(schema.sessionSnapshots)
      .set({
        recoveryError: sessionLifecycleError(
          env,
          detail ? `${classification.description} ${detail}` : classification.description
        ),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
          isNotNull(schema.sessionSnapshots.sleepingAt)
        )
      );
    log.warn('session_recovery.refused', {
      chatSessionId,
      reason,
      action: classification.action,
      detail: detail ?? null,
    });
  } else {
    log.info('session_recovery.deferred', {
      chatSessionId,
      reason,
      action: classification.action,
      detail: detail ?? null,
    });
  }
  return { status: 'unavailable', reason };
}

/** Record a terminal wake refusal found outside the VM recovery claim path. */
export function reportSessionRecoveryRefusal(
  env: Env,
  chatSessionId: string,
  reason: string,
  detail?: string | null
): Promise<SessionRecoveryResult> {
  return recordSessionRecoveryRefusal(
    drizzle(env.DATABASE, { schema }),
    env,
    chatSessionId,
    reason,
    detail
  );
}
