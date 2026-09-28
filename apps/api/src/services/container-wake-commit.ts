/**
 * Committing an Instant (cf-container) runtime's in-place wake to the session it serves.
 *
 * The container Durable Object restores the runtime and marks its D1 rows running
 * (`persistRuntimeRecovered`), but the session carries two more sleep markers: the
 * ProjectData chat session's `sleeping` status and the snapshot's `sleeping_at` /
 * `sleep_status`. Until both clear, `prepareSessionSnapshot` discards every new checkpoint,
 * and the next idle sleep (`VmAgentContainer.markRuntimeSleeping`) treats the old snapshot as
 * already verified. Whatever the woken agent did is then lost at the following wake.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import { markSessionSnapshotAwakeInPlace } from './session-snapshots';

export interface ContainerWakeTarget {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
}

/**
 * Clear the session's sleep markers after its container woke in place. Idempotent, so it is
 * safe on a session that is already awake. `beforeCommit` is the caller's revalidation, run
 * immediately before the writes; its denial is returned and nothing is written. A workspace
 * with no task has no session to commit.
 */
export async function commitContainerWake<Denial>(
  env: Env,
  target: ContainerWakeTarget,
  beforeCommit?: () => Promise<Denial | null>
): Promise<Denial | null> {
  const task = await env.DATABASE.prepare(
    `SELECT id FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1`
  )
    .bind(target.workspaceId)
    .first<{ id: string }>();
  if (!task) return null;
  const denied = beforeCommit ? await beforeCommit() : null;
  if (denied) return denied;
  await Promise.all([
    projectDataService.wakeSession(
      env,
      target.projectId,
      target.chatSessionId,
      target.workspaceId,
      task.id
    ),
    markSessionSnapshotAwakeInPlace(env, target.chatSessionId, task.id, target.workspaceId),
  ]);
  return null;
}

/**
 * The container DO's own commit, for a wake it performed on an unguarded request: an
 * attention answer, a prompt outside durable delivery, `/resume`, or anything else that
 * reached the slept container.
 *
 * Only a wake from sleep has markers to clear. A crash recovery of a session that never slept
 * leaves the session alone, since `wakeSession` would also revive a `failed` session. Never
 * throws: the runtime is already awake, so a failed commit must not fail the request. It is
 * logged, and the next durable delivery commits again before its prompt.
 */
export async function commitContainerWakeFromSleep(
  env: Env,
  target: ContainerWakeTarget
): Promise<void> {
  try {
    if (await sessionSnapshotSlept(env, target.chatSessionId)) {
      await commitContainerWake(env, target);
    }
  } catch (error) {
    log.warn('container_wake_commit.failed', {
      projectId: target.projectId,
      chatSessionId: target.chatSessionId,
      workspaceId: target.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Whether the session's snapshot still carries either sleep marker. */
async function sessionSnapshotSlept(env: Env, chatSessionId: string): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS slept
       FROM session_snapshots
      WHERE chat_session_id = ? AND (sleeping_at IS NOT NULL OR sleep_status = 'sleeping')
      LIMIT 1`
  )
    .bind(chatSessionId)
    .first<{ slept: number }>();
  return row !== null;
}
