import { DEFAULT_WORKSPACE_DELETION_CALLBACK_SIGNAL_TTL_SECONDS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

function signalTtlSeconds(env: Env): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_CALLBACK_SIGNAL_TTL_SECONDS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKSPACE_DELETION_CALLBACK_SIGNAL_TTL_SECONDS;
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
    const throttleKey = `workspace-deletion-callback:${workspaceId}:${kind}`;
    if (await env.KV.get(throttleKey)) return;
    await env.KV.put(throttleKey, '1', { expirationTtl: signalTtlSeconds(env) });
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
