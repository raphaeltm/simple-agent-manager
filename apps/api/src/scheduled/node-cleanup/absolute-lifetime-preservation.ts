/** Bounded preservation retries and escalation for active workspaces at absolute node lifetime. */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { recordNodeHealthEvent } from '../../services/node-health';
import { persistMessage } from '../../services/project-data';
import { queueWorkspaceSessionSleep } from '../../services/session-sleep';
import { DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS } from '../../services/session-snapshot-artifacts';
import { sessionSleepMaxAttempts } from '../../services/sleep-preserved-task-status';
import { type CleanupConfig, parseMs } from './config';

const REQUESTED = 'absolute_lifetime_preservation_requested';
const BLOCKED = 'absolute_lifetime_preservation_blocked';

type ActiveWorkspace = {
  id: string;
  user_id: string;
  project_id: string | null;
  chat_session_id: string | null;
  sleep_status: string | null;
  sleep_after: string | null;
  sleep_attempts: number | null;
  snapshot_status: string | null;
  degradation: string | null;
  snapshot_generation: string | null;
};

export async function prepareAbsoluteLifetimeRelease(
  env: Env,
  node: { id: string; created_at: string; runtime_incarnation_id?: string | null },
  now: Date,
  config: CleanupConfig
): Promise<boolean> {
  const rows = await env.DATABASE.prepare(
    `SELECT w.id, w.user_id, w.project_id, w.chat_session_id,
            s.sleep_status, s.sleep_after, s.sleep_attempts, s.status AS snapshot_status, s.degradation,
            s.snapshot_generation
     FROM workspaces w
     LEFT JOIN session_snapshots s ON s.chat_session_id = w.chat_session_id
       AND s.workspace_id = w.id AND s.node_id = w.node_id
     WHERE w.node_id = ? AND w.status IN ('running', 'creating', 'recovery')
     ORDER BY w.id LIMIT ?`
  )
    .bind(node.id, config.workspaceSweepLimit + 1)
    .all<ActiveWorkspace>();
  if (rows.results.length === 0) return true;
  if (rows.results.length > config.workspaceSweepLimit) {
    log.error('node_cleanup.absolute_lifetime_workspace_page_overflow', { nodeId: node.id });
    return false;
  }

  const nowIso = now.toISOString();
  const maxAttempts = sessionSleepMaxAttempts(env);
  const retryDelayMs = parseMs(
    env.SESSION_SLEEP_RETRY_DELAY_MS,
    DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS
  );
  const holdMs = Math.max(config.unhealthyReleaseAfterMs, maxAttempts * retryDelayMs);
  const episode = `${node.created_at}:${node.runtime_incarnation_id ?? ''}`;
  for (const workspace of rows.results) {
    let requested = await env.DATABASE.prepare(
      `SELECT created_at FROM node_health_events
       WHERE node_id = ? AND episode_started_at = ? AND event = ? AND reason = ? LIMIT 1`
    )
      .bind(node.id, episode, REQUESTED, workspace.id)
      .first<{ created_at: string }>();
    if (!requested) {
      await recordNodeHealthEvent(env, {
        nodeId: node.id,
        episodeStartedAt: episode,
        event: REQUESTED,
        reason: workspace.id,
        createdAt: nowIso,
      });
      requested = { created_at: nowIso };
    }

    const attempts = workspace.sleep_attempts ?? 0;
    if (
      attempts < maxAttempts &&
      workspace.sleep_status !== 'preparing' &&
      workspace.sleep_status !== 'stopping' &&
      // The sleep scheduler keeps the earliest deadline. Re-queueing a future
      // retry with zero delay would silently erase its configured backoff.
      (!workspace.sleep_after || workspace.sleep_after <= nowIso)
    ) {
      try {
        await queueWorkspaceSessionSleep(env, {
          workspaceId: workspace.id,
          userId: workspace.user_id,
          reason: 'absolute_node_lifetime',
          sleepAfterMs: 0,
          expectedNodeId: node.id,
        });
      } catch (error) {
        log.warn('node_cleanup.absolute_lifetime_sleep_unavailable', {
          nodeId: node.id,
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (now.getTime() - Date.parse(requested.created_at) < holdMs) {
      continue;
    }

    const blockedReason = `${workspace.id}:${workspace.chat_session_id ?? ''}:${workspace.snapshot_generation ?? ''}:${workspace.snapshot_status ?? 'missing'}:${workspace.degradation ?? 'unknown'}:${attempts}`;
    const recorded = await env.DATABASE.prepare(
      `SELECT 1 FROM node_health_events
       WHERE node_id = ? AND episode_started_at = ? AND event = ? AND reason = ? LIMIT 1`
    )
      .bind(node.id, episode, BLOCKED, blockedReason)
      .first();
    if (recorded) continue;

    // Exhausted attempts or elapsed budget is an escalation, never authority
    // to discard an uncaptured agent home. A separate verified migration or
    // owner-directed operation is required to release this active workspace.
    if (workspace.project_id && workspace.chat_session_id) {
      try {
        await persistMessage(
          env,
          workspace.project_id,
          workspace.chat_session_id,
          'system',
          `SAM could not preserve workspace ${workspace.id} before the managed node reached its absolute lifetime. Its snapshot is ${workspace.snapshot_status ?? 'missing'}/${workspace.degradation ?? 'unknown'} after ${attempts} sleep attempts. Automatic deletion is blocked to protect its agent home and unpublished files; an operator must resolve the preservation failure.`,
          { source: 'node_cleanup', kind: 'absolute_lifetime_preservation_blocked' },
          `absolute-lifetime-preservation-${node.id}-${workspace.id}`
        );
      } catch (error) {
        log.error('node_cleanup.absolute_lifetime_notice_failed', {
          nodeId: node.id,
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Keep the notice eligible for retry on the next sweep. The stable
        // message ID makes an ambiguous delivery safe to repeat.
        continue;
      }
    }
    await recordNodeHealthEvent(env, {
      nodeId: node.id,
      episodeStartedAt: episode,
      event: BLOCKED,
      reason: blockedReason,
      createdAt: nowIso,
    });
    log.error('node_cleanup.absolute_lifetime_preservation_blocked', {
      nodeId: node.id,
      workspaceId: workspace.id,
      snapshotStatus: workspace.snapshot_status,
      degradation: workspace.degradation,
      sleepAttempts: attempts,
    });
  }
  return false;
}
