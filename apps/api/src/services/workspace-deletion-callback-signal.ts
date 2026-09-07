import {
  DEFAULT_WORKSPACE_DELETION_CALLBACK_SIGNAL_CLEANUP_LIMIT,
  DEFAULT_WORKSPACE_DELETION_CALLBACK_SIGNAL_TTL_SECONDS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

export type WorkspaceDeletionCallbackKind =
  | 'acp_activity'
  | 'agent_credential_sync'
  | 'agent_key'
  | 'agent_settings'
  | 'boot_log'
  | 'bootstrap_token'
  | 'compose_image_artifact_complete'
  | 'compose_image_artifact_init'
  | 'compose_publish_release'
  | 'deployment_publish_job_event'
  | 'git_token'
  | 'messages'
  | 'node_acp_heartbeat'
  | 'provisioning_failed'
  | 'ready'
  | 'registry_push_cred'
  | 'runtime'
  | 'runtime_assets'
  | 'session_snapshot'
  | 'session_snapshot_artifact'
  | 'session_snapshot_artifact_download'
  | 'session_snapshot_complete'
  | 'session_snapshot_failure'
  | 'session_snapshot_prepare'
  | 'session_snapshot_progress'
  | 'session_snapshot_restore'
  | 'session_snapshot_restore_result'
  | 'task_status';

function signalTtlSeconds(env: Env): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_CALLBACK_SIGNAL_TTL_SECONDS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKSPACE_DELETION_CALLBACK_SIGNAL_TTL_SECONDS;
}

function cleanupLimit(env: Env): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_CALLBACK_SIGNAL_CLEANUP_LIMIT ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKSPACE_DELETION_CALLBACK_SIGNAL_CLEANUP_LIMIT;
}

/** Best-effort, payload-free evidence that an uncertain runtime is still calling back. */
export async function signalWorkspaceDeletionUnconfirmedCallback(
  env: Env,
  workspaceId: string,
  callback: WorkspaceDeletionCallbackKind
): Promise<void> {
  try {
    const row = await env.DATABASE.prepare(
      `SELECT project_id AS projectId,
              chat_session_id AS chatSessionId,
              status,
              node_id AS nodeId
         FROM workspaces
        WHERE id = ?
        LIMIT 1`
    )
      .bind(workspaceId)
      .first<{
        projectId: string | null;
        chatSessionId: string | null;
        status: string;
        nodeId: string | null;
      }>();
    if (!row?.projectId || row.status !== 'stopping') {
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + signalTtlSeconds(env) * 1000).toISOString();
    const [, claimed] = await env.DATABASE.batch([
      env.DATABASE.prepare(
        `DELETE FROM workspace_callback_signal_claims
          WHERE rowid IN (
            SELECT rowid
              FROM workspace_callback_signal_claims
             WHERE expires_at <= ?
             ORDER BY expires_at ASC
             LIMIT ?
          )`
      ).bind(nowIso, cleanupLimit(env)),
      env.DATABASE.prepare(
        `INSERT INTO workspace_callback_signal_claims
           (workspace_id, callback_kind, expires_at, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, callback_kind) DO UPDATE SET
           expires_at = excluded.expires_at,
           created_at = excluded.created_at
         WHERE workspace_callback_signal_claims.expires_at <= ?`
      ).bind(workspaceId, callback, expiresAt, nowIso, nowIso),
    ]);
    if ((claimed?.meta.changes ?? 0) !== 1) return;
    await projectDataService.recordActivityEvent(
      env,
      row.projectId,
      'workspace.deletion_unconfirmed_callback',
      'workspace_callback',
      workspaceId,
      workspaceId,
      row.chatSessionId,
      null,
      {
        callback,
        workspaceStatus: row.status,
        nodeId: row.nodeId,
        action: 'rejected',
      }
    );
  } catch (error) {
    log.warn('workspace_deletion.callback_signal_failed', {
      workspaceId,
      callback,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
