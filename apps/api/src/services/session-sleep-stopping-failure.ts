/** Bound ambiguous teardown without discarding the saved recovery artifacts. */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from './project-data';
import { parseSessionSleepFallbackRecord } from './session-sleep-episode';
import { endSessionSleepEpisodeBlocked } from './session-sleep-fallback';
import { sessionSleepBlockedNotice, sessionSleepNoticeId } from './session-sleep-fallback-messages';
import { sessionSleepRuntimeChanged } from './session-sleep-runtime-identity';
import { DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS } from './session-snapshot-artifacts';

export async function settleUnconfirmedSleepStop(
  env: Env,
  chatSessionId: string,
  claimId: string,
  error: unknown,
  now: Date
): Promise<boolean> {
  const db = drizzle(env.DATABASE, { schema });
  const snapshot = await db
    .select()
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  if (snapshot?.sleepStatus !== 'stopping' || snapshot.sleepClaimId !== claimId) return false;
  // Snapshot capture is bounded; external deletion/stop must keep retrying until
  // confirmed. Terminalizing an ambiguous stop would leave paid resources stranded.
  const runtimeChanged = sessionSleepRuntimeChanged(error);
  if (!runtimeChanged) return false;
  const blocked = await endSessionSleepEpisodeBlocked(env, {
    chatSessionId,
    reason: runtimeChanged ? 'runtime_changed' : 'teardown_unconfirmed',
    trigger: 'retry_ceiling',
    lastError: error instanceof Error ? error.message : String(error),
    expected: { kind: 'stopping_claim', claimId },
    now,
  });
  if (blocked) await reconcileUnconfirmedSleepBlock(env, chatSessionId, now);
  return blocked;
}

/** The durable retry deadline survives failures after the terminal snapshot CAS. */
export async function reconcileUnconfirmedSleepBlock(
  env: Env,
  chatSessionId: string,
  now: Date
): Promise<boolean> {
  const db = drizzle(env.DATABASE, { schema });
  const snapshot = await db
    .select()
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  const recordJson = snapshot?.sleepFallbackJson;
  const record = parseSessionSleepFallbackRecord(recordJson);
  if (
    !snapshot?.projectId ||
    !recordJson ||
    snapshot.sleepStatus !== 'terminal_failed' ||
    snapshot.sleepingAt ||
    record?.outcome !== 'blocked' ||
    !['teardown_unconfirmed', 'runtime_changed'].includes(record.blockedReason ?? '')
  )
    return false;
  const expected = and(
    eq(schema.sessionSnapshots.id, snapshot.id),
    eq(schema.sessionSnapshots.sleepStatus, 'terminal_failed'),
    eq(schema.sessionSnapshots.sleepFallbackJson, recordJson),
    isNull(schema.sessionSnapshots.sleepingAt)
  );
  try {
    // Mandatory here: a best-effort notice in the initial block is insufficient.
    await projectDataService.persistMessage(
      env,
      snapshot.projectId,
      chatSessionId,
      'system',
      sessionSleepBlockedNotice(record, snapshot.runtime),
      null,
      sessionSleepNoticeId('blocked', chatSessionId, String(Date.parse(record.decidedAt)))
    );
    if (record.blockedReason === 'runtime_changed') {
      // The old intent is blocked, but its successor's chat/task belong to the
      // replacement runtime. Never terminalize or clean up that successor.
      await db.update(schema.sessionSnapshots).set({ sleepAfter: null }).where(expected);
      return true;
    }
    const applied =
      snapshot.workspaceId &&
      (await projectDataService.finishBlockedSessionSleep(env, snapshot.projectId, {
        snapshotId: snapshot.id,
        chatSessionId,
        workspaceId: snapshot.workspaceId,
        recordJson: recordJson,
      }));
    if (!applied) {
      await db.update(schema.sessionSnapshots).set({ sleepAfter: null }).where(expected);
      return false;
    }
    const owner = await db
      .select({ taskId: schema.sessionSummaries.taskId })
      .from(schema.sessionSummaries)
      .where(
        and(
          eq(schema.sessionSummaries.id, chatSessionId),
          eq(schema.sessionSummaries.projectId, snapshot.projectId)
        )
      )
      .get();
    if (owner?.taskId)
      await db
        .update(schema.tasks)
        .set({
          executionStep: 'awaiting_followup',
          errorMessage:
            'Sleep teardown blocked; saved artifacts retained. Check the workspace before restarting.',
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(schema.tasks.projectId, snapshot.projectId),
            eq(schema.tasks.id, owner.taskId),
            inArray(schema.tasks.status, ['queued', 'delegated', 'in_progress', 'sleeping']),
            sql`EXISTS (SELECT 1 FROM session_snapshots s WHERE s.id = ${snapshot.id}
              AND s.sleep_status = 'terminal_failed' AND s.sleep_fallback_json = ${snapshot.sleepFallbackJson}
              AND s.sleeping_at IS NULL)`
          )
        );
    await db
      .update(schema.sessionSnapshots)
      .set({ sleepAfter: null, updatedAt: now.toISOString() })
      .where(expected);
    return true;
  } catch (error) {
    await db
      .update(schema.sessionSnapshots)
      .set({
        sleepAfter: new Date(
          now.getTime() +
            parsePositiveInt(env.SESSION_SLEEP_RETRY_DELAY_MS, DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS)
        ).toISOString(),
      })
      .where(expected);
    log.warn('session_sleep.blocked_reconciliation_failed', {
      chatSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
