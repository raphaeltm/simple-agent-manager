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
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Workspace states that still serve, or can still serve, the chat. */
const LIVE_CHAT_WORKSPACE_STATUSES = ['pending', 'creating', 'running', 'recovery', 'sleeping'];

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
        inArray(schema.workspaces.status, LIVE_CHAT_WORKSPACE_STATUSES)
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
