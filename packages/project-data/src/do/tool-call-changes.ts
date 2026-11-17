import { createModuleLogger } from '@simple-agent-manager/worker-core';

import { readMessageIngestState } from './message-stream-ingest';
import { estimateRowBytes, RPC_SIZE_BUDGET_BYTES } from './messages';
import { parseChatMessageRowCompact } from './row-schemas';
import { resolveCompactMessageOptions } from './tool-metadata-storage';
import type { Env } from './types';

const log = createModuleLogger('project_data.tool_changes');

/** Called synchronously before legacy snapshots are read. No transcript mutation or archive write. */
export function sealToolMerging(sql: SqlStorage, sessionId: string): boolean {
  const changed = sql
    .exec(
      `UPDATE chat_sessions SET stream_ingest_state = json_set(
    COALESCE(stream_ingest_state, '{"source":"","through":0,"maxSequence":0,"recent":[],"open":null}'),
    '$.toolLegacySeen', json('true'))
    WHERE id = ? AND COALESCE(json_extract(stream_ingest_state, '$.toolLegacySeen'), 0) = 0
    AND status != 'stopped'
    AND NOT EXISTS (SELECT 1 FROM project_data_archive_source_intents intent
      WHERE intent.session_id = chat_sessions.id AND intent.state != 'rehome_exported') RETURNING id`,
      sessionId
    )
    .toArray();
  return changed.length > 0;
}

export function readToolChanges(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  afterRevision?: number
) {
  const row = sql
    .exec('SELECT stream_ingest_state FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  const state = readMessageIngestState(row?.stream_ingest_state);
  const revision = state?.toolRevision ?? 0;
  let resetRequired =
    afterRevision !== undefined &&
    (afterRevision < (state?.toolChangesFloor ?? 0) || afterRevision > revision);
  const changes = (state?.toolChanges ?? []).filter(
    (change) => afterRevision === undefined || change.revision > afterRevision
  );
  const options = resolveCompactMessageOptions(env);
  const messages: ReturnType<typeof parseChatMessageRowCompact>[] = [];
  let bytes = 0;
  for (const change of changes) {
    const message = sql
      .exec(
        `SELECT id, session_id, role, content, tool_metadata, created_at, sequence, origin
      FROM chat_messages WHERE id = ? AND session_id = ?`,
        change.id,
        sessionId
      )
      .toArray()[0];
    if (!message) continue;
    try {
      const parsed = parseChatMessageRowCompact(message, options);
      bytes += estimateRowBytes(message);
      if (bytes > RPC_SIZE_BUDGET_BYTES) {
        // No partial cursor: discard cached history and take a fresh positional window.
        resetRequired = true;
        messages.length = 0;
        break;
      }
      messages.push(parsed);
    } catch (error) {
      log.warn('row_skipped', {
        messageId: change.id,
        table: 'chat_messages',
        error: String(error),
      });
    }
  }
  return { revision, floor: state?.toolChangesFloor ?? 0, resetRequired, messages };
}
