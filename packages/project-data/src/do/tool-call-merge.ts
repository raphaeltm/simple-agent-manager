import { createHash } from 'node:crypto';

import { maybeJsonRecord } from '@simple-agent-manager/worker-core';

import type { MessageIngestSource, StoredBatchMessage } from './message-stream-ingest';
import { refreshMaterializedTool } from './tool-call-search';
import { boundToolMetadataForStorage } from './tool-metadata-storage';
import type { Env } from './types';

/** Deterministic primary-key recovery makes an evictable locator map unnecessary. */
export function canonicalToolRowId(
  sessionId: string,
  source: MessageIngestSource,
  toolCallId: string
): string {
  return `tool-${createHash('sha256')
    .update(
      JSON.stringify([
        sessionId,
        source.workspaceId,
        source.callbackGeneration,
        source.outboxIncarnation,
        toolCallId,
      ])
    )
    .digest('hex')}`;
}

const STATUS_RANK: Readonly<Record<string, number>> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
  failed: 2,
};
const PLACEHOLDERS = new Set(['', '(tool call)', '(tool update)']);

function meaningful(value: unknown): boolean {
  if (value == null || value === '') return false;
  if (Array.isArray(value)) return value.some(meaningful);
  if (typeof value === 'object')
    return Object.entries(value).some(([key, item]) => key !== 'type' && meaningful(item));
  return true;
}

/** Sparse ACP updates are snapshots of supplied fields; absence never clears one. */
export function mergeToolSnapshot(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    // SAM owns revisions/identity/archive proofs, regardless of reporter metadata.
    if (key.startsWith('_samTool') || key.startsWith('toolPayloadArchive')) continue;
    if (!meaningful(value)) continue;
    if (key === 'status') {
      const prior = typeof previous.status === 'string' ? STATUS_RANK[previous.status] : undefined;
      const rank = typeof value === 'string' ? STATUS_RANK[value] : undefined;
      if (rank === undefined || (prior !== undefined && rank <= prior)) continue;
    }
    if (key === 'title' && (value === 'Tool Call' || value === '(tool call)')) continue;
    merged[key] = value;
  }
  return merged;
}

/** All calls run inside the existing archive mutex and synchronous ingest transaction. */
export function persistCanonicalTool(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  source: MessageIngestSource,
  message: StoredBatchMessage,
  hydration?: ReadonlyMap<string, import('./tool-call-hydration').HydratedToolPayload>
): { message: StoredBatchMessage; inserted: boolean } | null {
  const incoming = maybeJsonRecord(message.toolMetadata);
  if (message.role !== 'tool' || typeof incoming?.toolCallId !== 'string' || !incoming.toolCallId)
    return null;
  const id = canonicalToolRowId(sessionId, source, incoming.toolCallId);
  const row = sql
    .exec(
      'SELECT id, session_id, role, content, tool_metadata, created_at, sequence, origin FROM chat_messages WHERE id = ?',
      id
    )
    .toArray()[0];
  if (row && (row.session_id !== sessionId || row.role !== 'tool'))
    throw new Error('Canonical tool identity conflict');
  let previous =
    row && typeof row.tool_metadata === 'string'
      ? maybeJsonRecord(JSON.parse(row.tool_metadata))
      : null;
  const hydrated = hydration?.get(id);
  const archived =
    row &&
    (previous?.toolPayloadArchived ||
      sql
        .exec(
          'SELECT message_id FROM tool_payload_archives WHERE message_id = ? AND session_id = ?',
          id,
          sessionId
        )
        .toArray().length > 0);
  if (archived) {
    if (!hydrated || hydrated.storedMetadata !== row.tool_metadata)
      throw new Error('Canonical archived tool changed after verified hydration');
    previous = hydrated.metadata;
  }
  const revision =
    typeof previous?._samToolRevision === 'number' ? previous._samToolRevision + 1 : 1;
  const metadata = {
    ...mergeToolSnapshot(previous ?? {}, incoming),
    _samToolRevision: revision,
    _samToolUpdatedAt: Math.max(Number(previous?._samToolUpdatedAt ?? 0), message.createdAt),
    _samToolCanonicalId: id,
  };
  const bounded = boundToolMetadataForStorage(JSON.stringify(metadata), env);
  const boundedMeta = bounded.value ? maybeJsonRecord(JSON.parse(bounded.value)) : null;
  if (boundedMeta?._samToolRevision !== revision || boundedMeta?._samToolCanonicalId !== id)
    throw new Error('Canonical tool metadata budget cannot retain identity/revision');
  const content =
    row && PLACEHOLDERS.has(message.content.trim()) ? String(row.content) : message.content;
  const snapshot: StoredBatchMessage = {
    ...message,
    id,
    content,
    toolMetadata: bounded.value ? JSON.parse(bounded.value) : null,
    createdAt: row ? Number(row.created_at) : message.createdAt,
    sequence: row ? Number(row.sequence) : message.sequence,
    origin: row ? (typeof row.origin === 'string' ? row.origin : null) : message.origin,
  };
  if (row) {
    refreshMaterializedTool(sql, env, sessionId, snapshot, String(row.content));
    sql.exec(
      'UPDATE chat_messages SET content = ?, tool_metadata = ? WHERE id = ? AND session_id = ?',
      content,
      bounded.value,
      id,
      sessionId
    );
    if (archived)
      sql.exec(
        'DELETE FROM tool_payload_archives WHERE message_id = ? AND session_id = ?',
        id,
        sessionId
      );
  } else {
    sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      message.role,
      content,
      bounded.value,
      message.createdAt,
      message.sequence,
      message.origin
    );
  }
  return { message: snapshot, inserted: !row };
}
