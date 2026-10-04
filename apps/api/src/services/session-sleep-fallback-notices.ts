/**
 * Persisting the bounded sleep-failure notices into the conversation itself, so the
 * outcome is visible on every client and survives a reload. Ids are derived from the
 * decision record, so a roll-forward or a replayed sweep lands each notice once
 * (ProjectData resolves an identical replay to the existing message).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import type { SessionSleepFallbackRecord } from './session-sleep-episode';
import {
  sessionSleepBlockedNotice,
  sessionSleepFallbackNotice,
  sessionSleepNoticeId,
} from './session-sleep-fallback-messages';

function decisionKey(record: SessionSleepFallbackRecord): string {
  const decidedAt = Date.parse(record.decidedAt);
  return Number.isFinite(decidedAt)
    ? String(decidedAt)
    : record.decidedAt.replace(/[^0-9A-Za-z]/g, '');
}

/**
 * Write the fallback notice. Throws on failure: the caller must not release compute
 * until the conversation durably says what was and was not kept.
 */
export async function persistSessionSleepFallbackNotice(
  env: Env,
  input: { projectId: string; chatSessionId: string; record: SessionSleepFallbackRecord }
): Promise<void> {
  await projectDataService.persistMessage(
    env,
    input.projectId,
    input.chatSessionId,
    'system',
    sessionSleepFallbackNotice(input.record),
    null,
    sessionSleepNoticeId('fallback', input.chatSessionId, decisionKey(input.record))
  );
}

/**
 * Write the blocked notice. Best effort: the episode already ended, and a failed task's
 * own release (`releaseExhaustedFailedTaskPreservation`) explains the outcome in its
 * words, so a failed task gets no second notice here.
 */
export async function persistSessionSleepBlockedNotice(
  env: Env,
  input: {
    projectId: string;
    chatSessionId: string;
    runtime: string;
    record: SessionSleepFallbackRecord;
  }
): Promise<void> {
  try {
    // Loaded lazily: failed-task preservation queues sleeps through the sleep services.
    const { loadPreservationSnapshotOwner } = await import('./failed-task-preservation');
    const owner = await loadPreservationSnapshotOwner(env, input.chatSessionId);
    if (owner?.taskStatus === 'failed') return;
    await projectDataService.persistMessage(
      env,
      input.projectId,
      input.chatSessionId,
      'system',
      sessionSleepBlockedNotice(input.record, input.runtime),
      null,
      sessionSleepNoticeId('blocked', input.chatSessionId, decisionKey(input.record))
    );
  } catch (error) {
    log.warn('session_sleep.blocked_notice_failed', {
      chatSessionId: input.chatSessionId,
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
