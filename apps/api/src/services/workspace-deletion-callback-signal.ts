import {
  DEFAULT_WORKSPACE_DELETION_CALLBACK_SIGNAL_CLEANUP_LIMIT,
  DEFAULT_WORKSPACE_DELETION_CALLBACK_SIGNAL_TTL_SECONDS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

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

function callbackKind(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || 'unknown';
}

/** Best-effort, payload-free evidence that an uncertain runtime is still calling back. */
export async function signalWorkspaceDeletionUnconfirmedCallback(
  env: Env,
  workspaceId: string,
  callback: string
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

    const kind = callbackKind(callback);
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
      ).bind(workspaceId, kind, expiresAt, nowIso, nowIso),
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
        callback: kind,
        workspaceStatus: row.status,
        nodeId: row.nodeId,
        action: 'rejected',
      }
    );
  } catch (error) {
    log.warn('workspace_deletion.callback_signal_failed', {
      workspaceId,
      callback: callbackKind(callback),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
