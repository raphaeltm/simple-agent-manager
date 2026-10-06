/**
 * The seven-day session snapshot purge: terminalize the sleeping chat, delete its R2
 * objects, then remove the D1 metadata. Split out of \`d1-retention.ts\`
 * (\`.claude/rules/18-file-size-limits.md\`).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from '../services/project-data';
import { DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS } from '../services/session-snapshots';
import { destroyVmAgentContainer } from '../services/vm-agent-container';
import {
  type D1MutationResult,
  isEnabled,
  mutationChanges,
  type ScheduledSweepResult,
} from './retention-helpers';

export const DEFAULT_SESSION_SNAPSHOT_PURGE_BATCH_SIZE = 250;

export interface SessionSnapshotPurgeStats extends ScheduledSweepResult {
  batchSize: number;
  deletedSnapshots: number;
  deletedObjects: number;
  errors: number;
}

function sessionSnapshotPurgeBatchSize(env: Env): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_PURGE_BATCH_SIZE,
    DEFAULT_SESSION_SNAPSHOT_PURGE_BATCH_SIZE
  );
}

function emptySessionSnapshotPurgeStats(
  env: Env,
  overrides: Partial<SessionSnapshotPurgeStats> = {}
): SessionSnapshotPurgeStats {
  return {
    enabled: true,
    skipped: false,
    skipReason: null,
    batchSize: sessionSnapshotPurgeBatchSize(env),
    deletedSnapshots: 0,
    deletedObjects: 0,
    errors: 0,
    ...overrides,
  };
}

/**
 * Sleeping snapshots the seven-day purge retires: complete ones, and those a bounded
 * sleep fallback slept with (`sleep_fallback_json`, `session-sleep-episode.ts`), so a
 * fallback sleep keeps the same wake window and is cleaned up — R2 bundle included —
 * exactly like any other sleep. Other degraded sleeps predate the fallback and are left
 * as they were (idea 01M05HTJHCWXCG5YZJ6TB3Y2AG) rather than terminalized in bulk here.
 */
const PURGEABLE_SLEEPING_SNAPSHOT_SQL = `(status = 'available'
         OR (status = 'degraded' AND sleep_fallback_json IS NOT NULL))`;

/** Terminalize expired sessions, remove their R2 state, then purge bounded D1 metadata. */
export async function runSessionSnapshotPurge(
  env: Env,
  now: Date = new Date()
): Promise<SessionSnapshotPurgeStats> {
  if (!isEnabled(env.SESSION_SNAPSHOT_PURGE_ENABLED)) {
    return emptySessionSnapshotPurgeStats(env, {
      enabled: false,
      skipped: true,
      skipReason: 'disabled',
    });
  }

  const batchSize = sessionSnapshotPurgeBatchSize(env);
  const purgeClaimId = crypto.randomUUID();
  const staleClaimBefore = new Date(
    now.getTime() -
      parsePositiveInt(env.SESSION_SLEEP_CLAIM_LEASE_MS, DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS)
  ).toISOString();
  const candidates = await env.DATABASE.prepare(
    `SELECT id, project_id, workspace_id, node_id, chat_session_id, runtime,
            home_r2_key, wip_r2_key, manifest_r2_key
     FROM session_snapshots
     WHERE expires_at < ?
       AND sleeping_at IS NOT NULL
       AND (
         (${PURGEABLE_SLEEPING_SNAPSHOT_SQL} AND sleep_status = 'sleeping'
          AND (recovery_status IS NULL OR recovery_status != 'waking'))
         OR
         (status = 'expired' AND sleep_status = 'purging'
          AND (sleep_claimed_at IS NULL OR sleep_claimed_at <= ?))
       )
     ORDER BY expires_at ASC, id ASC
     LIMIT ?`
  )
    .bind(now.toISOString(), staleClaimBefore, batchSize)
    .all<{
      id: string;
      project_id: string | null;
      workspace_id: string | null;
      node_id: string | null;
      chat_session_id: string;
      runtime: string | null;
      home_r2_key: string | null;
      wip_r2_key: string | null;
      manifest_r2_key: string | null;
    }>();
  let deletedSnapshots = 0;
  let deletedObjects = 0;
  let errors = 0;

  for (const candidate of candidates.results ?? []) {
    try {
      const claim = (await env.DATABASE.prepare(
        `UPDATE session_snapshots
         SET status = 'expired', sleep_status = 'purging', sleep_claim_id = ?,
             sleep_claimed_at = ?, updated_at = ?
         WHERE id = ? AND expires_at < ? AND sleeping_at IS NOT NULL
           AND (
             (${PURGEABLE_SLEEPING_SNAPSHOT_SQL} AND sleep_status = 'sleeping'
              AND (recovery_status IS NULL OR recovery_status != 'waking'))
             OR
             (status = 'expired' AND sleep_status = 'purging'
              AND (sleep_claimed_at IS NULL OR sleep_claimed_at <= ?))
           )`
      )
        .bind(
          purgeClaimId,
          now.toISOString(),
          now.toISOString(),
          candidate.id,
          now.toISOString(),
          staleClaimBefore
        )
        .run()) as D1MutationResult;
      if (mutationChanges(claim) === 0) continue;

      // Once the seven-day restore window expires the chat becomes terminal,
      // preventing a later follow-up from silently starting without its state.
      if (candidate.project_id) {
        await projectDataService.stopSession(env, candidate.project_id, candidate.chat_session_id);
      }
      if (candidate.runtime === 'cf-container' && candidate.node_id) {
        await destroyVmAgentContainer(env, candidate.node_id);
      }

      const objectKeys = [
        candidate.home_r2_key,
        candidate.wip_r2_key,
        candidate.manifest_r2_key,
      ].filter((key): key is string => Boolean(key));
      if (objectKeys.length > 0) {
        await env.R2.delete(objectKeys);
        deletedObjects += objectKeys.length;
      }

      const result = (await env.DATABASE.prepare(
        `DELETE FROM session_snapshots
         WHERE id = ? AND expires_at < ? AND sleeping_at IS NOT NULL
           AND status = 'expired' AND sleep_status = 'purging' AND sleep_claim_id = ?`
      )
        .bind(candidate.id, now.toISOString(), purgeClaimId)
        .run()) as D1MutationResult;
      deletedSnapshots += mutationChanges(result);
    } catch (error) {
      errors++;
      log.warn('session_snapshot_purge.failed', {
        snapshotId: candidate.id,
        projectId: candidate.project_id,
        workspaceId: candidate.workspace_id,
        chatSessionId: candidate.chat_session_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return emptySessionSnapshotPurgeStats(env, {
    batchSize,
    deletedSnapshots,
    deletedObjects,
    errors,
  });
}

export async function runScheduledSessionSnapshotPurge(
  env: Env,
  now: Date = new Date()
): Promise<SessionSnapshotPurgeStats> {
  if (!isEnabled(env.SESSION_SNAPSHOT_PURGE_ENABLED)) {
    return emptySessionSnapshotPurgeStats(env, {
      enabled: false,
      skipped: true,
      skipReason: 'disabled',
    });
  }

  // Expiry is already bounded by SESSION_SNAPSHOT_PURGE_BATCH_SIZE. Run it on
  // every operational cron tick so a seven-day sleeping session is not retained
  // for up to another daily interval.
  return runSessionSnapshotPurge(env, now);
}
