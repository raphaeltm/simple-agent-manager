import type { ProjectData } from '@simple-agent-manager/project-data/durable-object';
import { ACP_INTERACTION_ATTENTION_SOURCE, formatInboxRef } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { log, serializeError } from '../lib/logger';
import { fileUndeliveredAnswerError, loadChatForError } from '../services/inbox/system-errors';
import * as notificationService from '../services/notification';
import { nowMs, parseSummary, terminalState } from './interaction-store-model';
import { readInteractionRow } from './interaction-store-read';

export async function projectInteractionAttention(
  sql: SqlStorage,
  env: Env,
  interactionId: string
): Promise<void> {
  const row = readInteractionRow(sql, interactionId);
  if (!row || terminalState(row.state) || row.attention_marker_id?.length) return;
  const stub = projectDataStub(env, row.project_id);
  const summary = parseSummary(row);
  const marker = await stub.createAttentionMarker({
    sessionId: row.chat_session_id,
    taskId: null,
    workspaceId: null,
    kind: 'needs_input',
    source: ACP_INTERACTION_ATTENTION_SOURCE,
    reason: 'acp_interaction_pending',
    metadata: canonicalJson({
      source: ACP_INTERACTION_ATTENTION_SOURCE,
      interactionId: row.interaction_id,
      kind: row.kind,
      state: row.state,
      toolCallId: summary.toolCallId,
    }),
    expiresAt: null,
  });
  sql.exec(
    `UPDATE interactions
       SET attention_marker_id = ?, attention_projection_state = 'created', updated_at = ?
       WHERE interaction_id = ?`,
    marker.id,
    nowMs(),
    interactionId
  );
  // Tell the person, once per request (slice E). This job runs only while the marker is unset.
  await notifyInteractionOwner(env, row, marker.id);
}

/** The chat's creator answers its permission requests; never throws. */
async function notifyInteractionOwner(
  env: Env,
  row: { project_id: string; chat_session_id: string; interaction_id: string; kind: string },
  markerId: string
): Promise<void> {
  if (!env.NOTIFICATION) return;
  try {
    const chat = await loadChatForError(env, row.project_id, row.chat_session_id);
    if (!chat?.createdBy) return;
    await notificationService.notifyInteractionRequested(env, chat.createdBy, {
      projectId: row.project_id,
      projectName: await notificationService.getProjectName(env, row.project_id),
      interactionId: row.interaction_id,
      interactionKind: row.kind,
      sessionId: row.chat_session_id,
      taskId: chat.taskId,
      topic: chat.topic,
      inboxRef: formatInboxRef({
        store: 'attention',
        sessionId: row.chat_session_id,
        markerId,
      }),
    });
  } catch (error) {
    log.warn('interaction_store.notify_failed', {
      interactionId: row.interaction_id,
      projectId: row.project_id,
      ...serializeError(error),
    });
  }
}

export async function resolveInteractionAttention(
  sql: SqlStorage,
  env: Env,
  interactionId: string
): Promise<void> {
  const row = readInteractionRow(sql, interactionId);
  if (!row?.attention_marker_id) return;
  const stub = projectDataStub(env, row.project_id);
  await stub.resolveAttentionMarkerById(
    row.attention_marker_id,
    'system',
    `${ACP_INTERACTION_ATTENTION_SOURCE}:${row.state}`
  );
  const resolved = sql.exec(
    `UPDATE interactions
       SET attention_projection_state = 'resolved', updated_at = ?
       WHERE interaction_id = ? AND attention_projection_state IS NOT 'resolved'`,
    nowMs(),
    interactionId
  ).rowsWritten;
  // The person answered but the agent never confirmed it (`recordDelivery`, outcome
  // `unconfirmed`): their inbox says so (slice E). Once, on this projection. Never throws.
  if (resolved > 0 && row.state === 'delivery_unconfirmed') {
    await fileUndeliveredAnswerError(env, {
      projectId: row.project_id,
      sessionId: row.chat_session_id,
    });
  }
}

function projectDataStub(env: Env, projectId: string): DurableObjectStub<ProjectData> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
}
