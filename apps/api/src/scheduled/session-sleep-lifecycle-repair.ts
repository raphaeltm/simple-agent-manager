import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from '../services/project-data';
import {
  finishSleepingWorkspaceComputeCleanup,
  markWorkspaceNodeWarmIfEmpty,
} from '../services/session-sleep';
import { markSessionSnapshotSleeping } from '../services/session-snapshot-sleep-lifecycle';
import { sessionSleepInFlightMaxAgeMs } from '../services/session-snapshot-sleep-predicate';

export const DEFAULT_SESSION_SLEEP_IN_FLIGHT_REPAIR_BATCH_SIZE = 25;
export const MAX_SESSION_SLEEP_IN_FLIGHT_REPAIR_BATCH_SIZE = 100;

export interface SessionSleepLifecycleRepairStats {
  selected: number;
  repaired: number;
  skipped: number;
  projectDataErrors: number;
  errors: number;
}

function repairBatchSize(env: Env): number {
  return Math.min(
    MAX_SESSION_SLEEP_IN_FLIGHT_REPAIR_BATCH_SIZE,
    Math.max(
      1,
      parsePositiveInt(
        env.SESSION_SLEEP_IN_FLIGHT_REPAIR_BATCH_SIZE,
        DEFAULT_SESSION_SLEEP_IN_FLIGHT_REPAIR_BATCH_SIZE
      )
    )
  );
}

/**
 * Complete stale post-capture sleep rows that already hold restorable snapshot
 * data. This is the bounded escape for a worker crash after the snapshot was
 * captured but before the durable sleeping transition finished. It never wakes
 * or replays agent work, and it intentionally ignores pre-capture rows.
 */
export async function runSessionSleepLifecycleRepair(
  env: Env,
  now = new Date()
): Promise<SessionSleepLifecycleRepairStats> {
  const db = drizzle(env.DATABASE, { schema });
  const cutoff = new Date(now.getTime() - sessionSleepInFlightMaxAgeMs(env)).toISOString();
  const rows = await db
    .select({
      snapshotId: schema.sessionSnapshots.id,
      workspaceId: schema.sessionSnapshots.workspaceId,
      userId: schema.sessionSnapshots.userId,
      projectId: schema.sessionSnapshots.projectId,
      chatSessionId: schema.sessionSnapshots.chatSessionId,
      nodeId: schema.sessionSnapshots.nodeId,
      nodeRole: schema.nodes.nodeRole,
      runtime: schema.sessionSnapshots.runtime,
      taskId: schema.tasks.id,
      warmNodeTimeoutMs: schema.projects.warmNodeTimeoutMs,
    })
    .from(schema.sessionSnapshots)
    .leftJoin(schema.workspaces, eq(schema.workspaces.id, schema.sessionSnapshots.workspaceId))
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.sessionSnapshots.nodeId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.sessionSnapshots.projectId))
    .leftJoin(
      schema.sessionSummaries,
      eq(schema.sessionSummaries.id, schema.sessionSnapshots.chatSessionId)
    )
    .leftJoin(
      schema.tasks,
      or(
        eq(schema.tasks.id, schema.sessionSummaries.taskId),
        and(
          isNull(schema.sessionSummaries.taskId),
          eq(schema.tasks.chatSessionId, schema.sessionSnapshots.chatSessionId)
        )
      )
    )
    .where(
      and(
        isNull(schema.sessionSnapshots.sleepingAt),
        or(
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
            lte(
              sql`COALESCE(${schema.sessionSnapshots.sleepClaimedAt}, ${schema.sessionSnapshots.updatedAt}, ${schema.sessionSnapshots.createdAt})`,
              cutoff
            )
          ),
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
            lte(
              sql`COALESCE(${schema.sessionSnapshots.sleepStoppingSince}, ${schema.sessionSnapshots.sleepClaimedAt}, ${schema.sessionSnapshots.updatedAt}, ${schema.sessionSnapshots.createdAt})`,
              cutoff
            )
          )
        ),
        gt(schema.sessionSnapshots.expiresAt, now.toISOString()),
        or(
          and(
            eq(schema.sessionSnapshots.status, 'available'),
            eq(schema.sessionSnapshots.degradation, 'none')
          ),
          and(
            eq(schema.sessionSnapshots.status, 'degraded'),
            inArray(schema.sessionSnapshots.degradation, [
              'home-skipped',
              'wip-skipped',
              'entries-skipped',
              'transcript-only',
            ])
          )
        )
      )
    )
    .orderBy(schema.sessionSnapshots.sleepClaimedAt, schema.sessionSnapshots.id)
    .limit(repairBatchSize(env));

  const stats: SessionSleepLifecycleRepairStats = {
    selected: rows.length,
    repaired: 0,
    skipped: 0,
    projectDataErrors: 0,
    errors: 0,
  };

  for (const row of rows) {
    try {
      if (!row.projectId || !row.chatSessionId || !row.workspaceId) {
        stats.skipped++;
        continue;
      }
      const projectDataSlept = await projectDataService
        .sleepSession(env, row.projectId, row.chatSessionId)
        .catch((error) => {
          log.warn('session_sleep_lifecycle_repair.project_data_sleep_failed', {
            snapshotId: row.snapshotId,
            workspaceId: row.workspaceId,
            chatSessionId: row.chatSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
      if (!projectDataSlept) {
        stats.projectDataErrors++;
        log.warn('session_sleep_lifecycle_repair.project_data_sleep_not_applied', {
          snapshotId: row.snapshotId,
          workspaceId: row.workspaceId,
          chatSessionId: row.chatSessionId,
        });
        continue;
      }
      const marked = await markSessionSnapshotSleeping(db, env, row.chatSessionId, now);
      if (!marked) {
        stats.skipped++;
        continue;
      }
      const nowIso = now.toISOString();
      await db.batch([
        db
          .update(schema.workspaces)
          .set({ status: 'sleeping', errorMessage: null, updatedAt: nowIso })
          .where(eq(schema.workspaces.id, row.workspaceId)),
        db
          .update(schema.agentSessions)
          .set({ status: 'sleeping', errorMessage: null, updatedAt: nowIso })
          .where(eq(schema.agentSessions.workspaceId, row.workspaceId)),
      ]);
      await finishSleepingWorkspaceComputeCleanup(db, env, {
        workspaceId: row.workspaceId,
        taskId: row.taskId ?? null,
        warmNodeTimeoutMs: row.warmNodeTimeoutMs ?? null,
      });
      if (row.nodeId) {
        await markWorkspaceNodeWarmIfEmpty(db, env, {
          nodeId: row.nodeId,
          nodeRole: row.nodeRole ?? '',
          runtime: row.runtime ?? 'vm',
          userId: row.userId,
          warmNodeTimeoutMs: row.warmNodeTimeoutMs ?? null,
        });
      }
      stats.repaired++;
    } catch (error) {
      stats.errors++;
      log.warn('session_sleep_lifecycle_repair.row_failed', {
        snapshotId: row.snapshotId,
        workspaceId: row.workspaceId,
        chatSessionId: row.chatSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (stats.repaired > 0 || stats.errors > 0 || stats.projectDataErrors > 0) {
    log.info('session_sleep_lifecycle_repair.completed', { ...stats });
  }

  return stats;
}
