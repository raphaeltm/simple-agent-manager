/** Caller holds the DO concurrency gate across the authoritative read and local write. */
import {
  parseProviderLimitWait,
} from '../../scheduler-core';
import {
  createAttentionMarker,
  listActiveAttentionMarkers,
  resolveAttentionMarkersByKind,
} from './attention';
import { sleepSession } from './sessions';

export interface ProviderLimitAttentionResult {
  blocked: boolean;
  changed: boolean;
  markerId: string | null;
  reason: string | null;
}

export async function syncProviderLimitAttention(
  sql: SqlStorage,
  database: D1Database,
  input: { projectId: string; taskId: string; sessionId: string }
): Promise<ProviderLimitAttentionResult> {
  const task = await database
    .prepare(
      `SELECT status,workspace_id,provider_limit_wait_json FROM tasks WHERE id=? AND project_id=? AND chat_session_id=?`
    )
    .bind(input.taskId, input.projectId, input.sessionId)
    .first<{
      status: string;
      workspace_id: string | null;
      provider_limit_wait_json: string | null;
    }>();
  const wait = parseProviderLimitWait(task?.provider_limit_wait_json);
  const blocked =
    !!task &&
    !['completed', 'failed', 'cancelled'].includes(task.status) &&
    wait?.phase === 'blocked';
  // Never resolve human input or approval markers as a side effect of a provider wait.
  if (!blocked) {
    const count = resolveAttentionMarkersByKind(
      sql,
      input.sessionId,
      'provider_limit_blocked',
      null,
      'system',
      'provider_limit_released'
    );
    return { blocked: false, changed: count > 0, markerId: null, reason: null };
  }
  if (!task.workspace_id && task.status === 'sleeping') sleepSession(sql, input.sessionId);
  resolveAttentionMarkersByKind(
    sql,
    input.sessionId,
    'wake_failed',
    null,
    'system',
    'provider_limit_blocked'
  );
  const existing = listActiveAttentionMarkers(sql, input.sessionId).find(
    (marker) => marker.kind === 'provider_limit_blocked'
  );
  if (existing)
    return { blocked: true, changed: false, markerId: existing.id, reason: wait.reason };
  const marker = createAttentionMarker(sql, {
    sessionId: input.sessionId,
    taskId: input.taskId,
    workspaceId: task.workspace_id,
    kind: 'provider_limit_blocked',
    source: 'provider_limit',
    reason: wait.reason,
  });
  return { blocked: true, changed: true, markerId: marker.id, reason: wait.reason };
}
