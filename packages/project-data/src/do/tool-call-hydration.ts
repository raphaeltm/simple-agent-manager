import { maybeJsonRecord } from '@simple-agent-manager/worker-core';

import type { BatchMessageInput } from './message-persistence';
import {
  type MessageIngestSource,
  type MessageMergeConfig,
  MessageStreamBatch,
  readMessageIngestState,
} from './message-stream-ingest';
import { parseMessageCount } from './row-schemas';
import { resolveStorageSafetyConfig } from './storage-safety';
import { canonicalToolRowId } from './tool-call-merge';
import {
  readArchivedMessageToolContent,
  selectArchivedToolPayloadRow,
} from './tool-payload-archive-read';
import { assertTranscriptWriteAllowed } from './transcript-write-fence';
import type { Env } from './types';

export interface HydratedToolPayload {
  metadata: Record<string, unknown>;
  /** Compare-and-set against cleanup's concurrent writer, which has its own mutex. */
  storedMetadata: string;
}

/** Caller holds archive transcript mutex across this preflight and the ingest transaction. */
export async function hydrateCanonicalTools(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  source: MessageIngestSource,
  messages: readonly BatchMessageInput[],
  mergeConfig: MessageMergeConfig
): Promise<Map<string, HydratedToolPayload>> {
  assertTranscriptWriteAllowed(sql, sessionId, 'hydrateCanonicalTools');
  const result = new Map<string, HydratedToolPayload>();
  const session = sql
    .exec('SELECT message_count,stream_ingest_state FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  if (!session) return result;
  // Use the same durable receipts and eligibility predicate as the synchronous writer.
  const stream = new MessageStreamBatch(
    sessionId,
    mergeConfig,
    readMessageIngestState(session.stream_ingest_state),
    source,
    messages.map((message) => message.sequence),
    null,
    null,
    null,
    messages.map((message) => message.messageId),
    parseMessageCount(session, 'tools.hydration_count')
  );
  if (!stream.canMergeTools) return result;
  const config = resolveStorageSafetyConfig(env);
  const operationBudget = { used: 0, max: config.toolPayloadArchiveMaxOperations };
  const deadlineMs = Date.now() + config.toolPayloadArchiveWriteTimeoutMs;
  for (const message of messages) {
    if (stream.isDuplicate(message.messageId, message.sequence)) continue;
    if (message.role !== 'tool' || !message.toolMetadata) continue;
    const metadata = maybeJsonRecord(JSON.parse(message.toolMetadata));
    if (typeof metadata?.toolCallId !== 'string' || !metadata.toolCallId) continue;
    const id = canonicalToolRowId(sessionId, source, metadata.toolCallId);
    if (result.has(id) || !selectArchivedToolPayloadRow(sql, id, sessionId)) continue;
    const row = sql
      .exec(
        'SELECT tool_metadata FROM chat_messages WHERE id = ? AND session_id = ?',
        id,
        sessionId
      )
      .toArray()[0];
    if (typeof row?.tool_metadata !== 'string')
      throw new Error('Canonical archived tool is missing its row');
    const previous = maybeJsonRecord(JSON.parse(row.tool_metadata));
    if (!previous) throw new Error('Canonical archived tool metadata is invalid');
    const project = sql.exec("SELECT value FROM do_meta WHERE key = 'projectId'").toArray()[0];
    // Project identity is supplied by the stored DO identity, never a reporter field.
    const projectId = typeof project?.value === 'string' ? project.value : '';
    const archived = await readArchivedMessageToolContent(sql, env, projectId, sessionId, id, {
      operationBudget,
      timeoutMs: config.toolPayloadArchiveWriteTimeoutMs,
      deadlineMs,
      nowMs: Date.now,
    });
    if (archived?.source !== 'archive')
      throw new Error('Canonical archived tool payload could not be verified');
    const restored: Record<string, unknown> = { ...previous, content: archived.content };
    delete restored.toolPayloadArchived;
    delete restored.toolPayloadArchive;
    result.set(id, { metadata: restored, storedMetadata: row.tool_metadata });
  }
  return result;
}
