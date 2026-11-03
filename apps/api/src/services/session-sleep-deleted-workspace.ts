/**
 * Close the chat of a workspace that was deleted while its sleep was still pending.
 *
 * On node deletion the lifecycle finalizer keeps a chat whose sleep is in flight open
 * (`workspace-lifecycle-finalizer.ts`, `findRestorableOrInFlightSleepSnapshot`), expecting the
 * sleep to finish. With the workspace deleted it never can: the sweep retires the intent
 * (`retireDeadWorkspaceSleepIntent`), `sleeping_at` stays NULL, and the wake path
 * (`loadRecoveryContext`) refuses the chat. Production 2026-11-03: chat
 * `ba36fd60-6b16-4001-a019-173cb8b2e9aa` stayed `active` with no runtime and no way to wake.
 *
 * This finishes what the finalizer deferred, with the outcome it gives every other workspace
 * that node deletion removes: the ProjectData session is stopped and its transcript kept.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from './project-data';
import { DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS } from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function closeChatOfDeletedSleepWorkspace(
  env: Env,
  db: Db,
  input: { snapshotId: string; chatSessionId: string; workspaceId: string }
): Promise<boolean> {
  const snapshot = await db
    .select({ projectId: schema.sessionSnapshots.projectId })
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.id, input.snapshotId),
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        // A chat with a sleeping snapshot can still be woken; never close it.
        isNull(schema.sessionSnapshots.sleepingAt)
      )
    )
    .get();
  if (!snapshot?.projectId) return false;

  const live = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.chatSessionId, input.chatSessionId),
        // Every other state still serves the chat, or can be restarted, recovered or woken
        // to serve it. Excluding only `deleted` keeps any future state on the safe side.
        ne(schema.workspaces.status, 'deleted')
      )
    )
    .get();
  if (live) return false;

  await projectDataService.stopSession(env, snapshot.projectId, input.chatSessionId);
  log.info('session_sleep_sweep.deleted_workspace_chat_closed', {
    snapshotId: input.snapshotId,
    chatSessionId: input.chatSessionId,
    workspaceId: input.workspaceId,
    projectId: snapshot.projectId,
  });
  return true;
}

/** `sleep_error` while a failed close waits for its next try. */
export const DELETED_WORKSPACE_CHAT_CLOSE_RETRYING =
  'Closing the chat of the deleted workspace failed; retrying';

/**
 * After a failed close, keep the intent and try again later. It is never retired unclosed: a
 * retired intent is never selected again, so the chat would stay `active` with no runtime and
 * no wake path for good. The retry waits the ordinary sleep retry delay, as a `failed` intent
 * the sweep selects by `sleep_after`, so a close that keeps failing costs one sweep slot per
 * delay rather than one per tick. Any status may be rewritten: with the workspace deleted the
 * intent is dead whatever its status (`isDeadSleepIntentWorkspace`).
 */
export async function deferDeletedWorkspaceChatClose(
  db: Db,
  env: Env,
  snapshotId: string,
  now: Date
): Promise<void> {
  const retryDelayMs = parsePositiveInt(
    env.SESSION_SLEEP_RETRY_DELAY_MS,
    DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS
  );
  await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'failed',
      sleepAfter: new Date(now.getTime() + retryDelayMs).toISOString(),
      sleepError: DELETED_WORKSPACE_CHAT_CLOSE_RETRYING,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(eq(schema.sessionSnapshots.id, snapshotId), isNull(schema.sessionSnapshots.sleepingAt))
    );
}
