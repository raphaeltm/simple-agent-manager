import { ACP_INTERACTION_ATTENTION_SOURCE } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { nowMs, parseSummary, terminalState } from './interaction-store-model';
import { readInteractionRow } from './interaction-store-read';
import type { ProjectData } from './project-data';

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
  sql.exec(
    `UPDATE interactions
       SET attention_projection_state = 'resolved', updated_at = ?
       WHERE interaction_id = ?`,
    nowMs(),
    interactionId
  );
}

function projectDataStub(env: Env, projectId: string): DurableObjectStub<ProjectData> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
}
