import { log } from '@simple-agent-manager/worker-core';

import { countIngestRole, type MessageIngestMetrics, refuseMerge } from './message-ingest-metrics';
import {
  type MessageIngestSource,
  type MessageMergeConfig,
  MessageStreamBatch,
  readMessageIngestState,
} from './message-stream-ingest';
import {
  nextSequence,
  resolveMaxMessagesPerSession,
  SessionMessageLimitExceededError,
} from './messages-persist-helpers';
import { parseMessageCount, parseWorkspaceId } from './row-schemas';
import { markRuntimeReported, withoutSamNotice } from './sam-notice-metadata';
import { assertSessionIdentityGuard } from './sessions';
import { canonicalToolRowId, persistCanonicalTool } from './tool-call-merge';
import { boundToolMetadataForStorage } from './tool-metadata-storage';
import { assertTranscriptWriteAllowed } from './transcript-write-fence';
import type { Env } from './types';

export function persistMessageBatch(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  messages: Array<{
    messageId: string;
    role: string;
    content: string;
    toolMetadata: string | null;
    timestamp: string;
    sequence?: number;
    origin?: string | null;
  }>,
  context?: {
    source?: MessageIngestSource;
    config: MessageMergeConfig;
    metrics?: MessageIngestMetrics;
    hydration?: ReadonlyMap<string, import('./tool-call-hydration').HydratedToolPayload>;
  }
): {
  persisted: number;
  duplicates: number;
  persistedMessages: Array<{
    id: string;
    role: string;
    content: string;
    toolMetadata: unknown;
    createdAt: number;
    sequence: number;
    origin: string | null;
  }>;
  workspaceId: string | null;
  firstUserContent: string | null;
  hadTopic: boolean;
  limitReached: boolean;
  maxMessages: number;
  remainingCapacity: number;
  broadcastMessages: Array<import('./message-stream-ingest').StoredBatchMessage>;
  appends: Array<import('@simple-agent-manager/shared').ChatMessageAppend>;
} {
  assertTranscriptWriteAllowed(sql, sessionId, 'persistMessageBatch');
  const session = sql
    .exec(
      `SELECT id, workspace_id, message_count, topic, status, last_message_sequence, last_message_sequence_count, stream_ingest_state,
      materialized_at, materialized_through_created_at, materialized_through_sequence,
      (SELECT prompt_epoch FROM session_state WHERE session_id = chat_sessions.id) AS prompt_epoch
      FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.status === 'stopped') {
    throw new Error(`Session ${sessionId} is stopped and cannot accept messages`);
  }

  const metrics = context?.metrics;
  if (metrics) {
    metrics.batches++;
    for (const message of messages) countIngestRole(metrics.received, message.role);
  }
  if (!context?.config.enabled) refuseMerge(metrics, 'setting_disabled');
  else if (!context.source?.outboxIncarnation) refuseMerge(metrics, 'missing_incarnation');
  const previousStream = readMessageIngestState(session.stream_ingest_state);
  const merging = context?.config.enabled || context?.config.toolUpdatesEnabled === true;
  if (context?.source && (merging || previousStream))
    assertSessionIdentityGuard(sql, sessionId, 'persist message batch', {
      workspaceId: context.source.workspaceId,
    });
  const latest =
    previousStream?.open || (merging && context?.source?.outboxIncarnation)
      ? sql
          .exec(
            'SELECT id, created_at, sequence FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, sequence DESC, id DESC LIMIT 1',
            sessionId
          )
          .toArray()[0]
      : null;
  const stream =
    context && (previousStream || (merging && context.source?.outboxIncarnation))
      ? new MessageStreamBatch(
          sessionId,
          context.config,
          previousStream,
          context.source,
          messages.map((message) => message.sequence),
          typeof session.prompt_epoch === 'number' ? session.prompt_epoch : null,
          typeof latest?.id === 'string'
            ? {
                id: latest.id,
                createdAt: Number(latest.created_at),
                sequence: Number(latest.sequence),
              }
            : null,
          typeof session.materialized_through_created_at === 'number'
            ? {
                createdAt: session.materialized_through_created_at,
                sequence: Number(session.materialized_through_sequence ?? 0),
              }
            : typeof session.materialized_at === 'number'
              ? {
                  createdAt: session.materialized_at,
                  sequence: Number.MAX_SAFE_INTEGER,
                }
              : null,
          messages.map((message) => message.messageId),
          parseMessageCount(session, 'messages.batch_stream_count'),
          metrics
        )
      : null;

  const maxMessages = resolveMaxMessagesPerSession(env);
  const startingCount = parseMessageCount(session, 'messages.batch_count');
  let persisted = 0;
  let duplicates = 0;
  let limitReached = false;
  const now = Date.now();
  let nextSeq = nextSequence(sql, sessionId, session);
  let maximumSequence = nextSeq - 1;
  const persistedMessages: Array<{
    id: string;
    role: string;
    content: string;
    toolMetadata: unknown;
    createdAt: number;
    sequence: number;
    origin: string | null;
  }> = [];

  // Track user message content seen within this batch to avoid redundant
  // DB queries when the same user content appears multiple times in one batch.
  const seenUserContent = new Set<string>();
  const tools = new Map<string, import('./message-stream-ingest').StoredBatchMessage>();

  for (const msg of messages) {
    const origin = msg.origin ?? null;
    if (stream?.isDuplicate(msg.messageId, msg.sequence)) {
      stream.consume(msg.messageId, msg.sequence);
      duplicates++;
      continue;
    }
    stream?.boundary(msg.role, msg.toolMetadata);
    const existing = sql
      .exec('SELECT id FROM chat_messages WHERE id = ?', msg.messageId)
      .toArray()[0];

    if (existing) {
      stream?.consume(msg.messageId, msg.sequence);
      duplicates++;
      continue;
    }

    // Content-based dedup for user messages: the same user message may arrive
    // via both the DO WebSocket (message.send → persistMessage) and the VM
    // agent batch (ExtractMessages generates a new UUID). The ID-based check
    // above misses this because the two paths use different IDs for the same
    // content. Skip batch user messages whose content is already persisted.
    //
    // Ordering guarantee: persistMessage (WebSocket path) always runs before
    // persistMessageBatch (VM agent batch path) because the WebSocket handler
    // persists synchronously on receipt, while the batch arrives after the VM
    // agent processes the prompt, extracts messages, and flushes (~2-5s later).
    if (msg.role === 'user' && origin !== 'system') {
      if (seenUserContent.has(msg.content)) {
        stream?.consume(msg.messageId, msg.sequence);
        duplicates++;
        continue;
      }
      const contentDup = sql
        .exec(
          'SELECT id FROM chat_messages WHERE session_id = ? AND role = ? AND content = ? LIMIT 1',
          sessionId,
          msg.role,
          msg.content
        )
        .toArray()[0];
      if (contentDup) {
        stream?.consume(msg.messageId, msg.sequence);
        duplicates++;
        continue;
      }
      seenUserContent.add(msg.content);
    }

    const currentCount = startingCount + persisted;
    if (currentCount >= maxMessages) {
      limitReached = true;
      break;
    }

    // Rows without a usable timestamp share `now`; reads page on (created_at, sequence, id),
    // so ties are safe (see message-cursor.ts).
    const createdAt = new Date(msg.timestamp).getTime() || now;
    // Preserve reporter positions and the established within-batch allocator.
    // The watermark caches the maximum, independently of the next fallback position.
    const sequence = msg.sequence ?? nextSeq++;
    maximumSequence = Math.max(maximumSequence, sequence);
    const boundedToolMetadata = boundToolMetadataForStorage(
      withoutSamNotice(msg.toolMetadata, sessionId, msg.messageId),
      env
    );
    if (boundedToolMetadata.truncated) {
      log.warn('messages.batch_tool_metadata_truncated_for_storage', {
        sessionId,
        messageId: msg.messageId,
        originalBytes: boundedToolMetadata.originalBytes,
        storedBytes: boundedToolMetadata.storedBytes,
      });
    }
    let storedToolMetadata =
      msg.role === 'system'
        ? markRuntimeReported(boundedToolMetadata.value)
        : boundedToolMetadata.value;
    if (
      msg.role === 'tool' &&
      context?.source?.outboxIncarnation &&
      !stream?.canMergeTools &&
      (context.config.toolUpdatesEnabled || (previousStream?.toolRevision ?? 0) > 0)
    ) {
      const metadata = storedToolMetadata ? JSON.parse(storedToolMetadata) : null;
      if (metadata && typeof metadata.toolCallId === 'string') {
        storedToolMetadata = boundToolMetadataForStorage(
          JSON.stringify({
            ...metadata,
            _samToolCanonicalId: canonicalToolRowId(sessionId, context.source, metadata.toolCallId),
          }),
          env
        ).value;
      }
    }
    let canonicalId = msg.messageId;
    const input = {
      id: msg.messageId,
      role: msg.role,
      content: msg.content,
      toolMetadata: storedToolMetadata ? JSON.parse(storedToolMetadata) : null,
      createdAt,
      sequence,
      origin,
    };
    const tool =
      stream?.canMergeTools && context?.source
        ? persistCanonicalTool(sql, env, sessionId, context.source, input, context.hydration)
        : null;
    if (tool && stream) {
      canonicalId = tool.message.id;
      tools.set(canonicalId, tool.message);
      stream.reserveTool(input);
      stream.recordToolChange(canonicalId);
      stream.consume(msg.messageId, msg.sequence);
      if (metrics && tool.inserted) countIngestRole(metrics.inserted, 'tool');
      else if (metrics) metrics.toolUpdatedRows++;
    } else if (stream) {
      canonicalId = stream.stage(
        {
          id: msg.messageId,
          role: msg.role,
          content: msg.content,
          toolMetadata: storedToolMetadata ? JSON.parse(storedToolMetadata) : null,
          createdAt,
          sequence,
          origin,
        },
        msg.sequence,
        storedToolMetadata
      );
      stream.consume(msg.messageId, msg.sequence);
    } else
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        msg.messageId,
        sessionId,
        msg.role,
        msg.content,
        storedToolMetadata,
        createdAt,
        sequence,
        origin
      );
    if (metrics && msg.role === 'tool' && !tool) {
      const reason =
        stream?.toolMergeRefusal ??
        (stream?.canMergeTools
          ? 'missing_tool_id'
          : context?.config.toolUpdatesEnabled
            ? 'missing_incarnation'
            : 'setting_disabled');
      if (reason) metrics.toolRefused[reason] = (metrics.toolRefused[reason] ?? 0) + 1;
    }
    if (msg.role === 'tool' && !tool) stream?.sealToolFallback();
    if (metrics) {
      countIngestRole(metrics.accepted, msg.role);
      if (msg.role === 'assistant' && storedToolMetadata === null) metrics.eligible++;
      if (!stream) countIngestRole(metrics.inserted, msg.role);
    }
    persisted++;
    persistedMessages.push({
      id: canonicalId,
      role: msg.role,
      content: msg.content,
      toolMetadata: storedToolMetadata ? JSON.parse(storedToolMetadata) : null,
      createdAt,
      sequence,
      origin,
    });
  }

  let workspaceId: string | null = null;
  let firstUserContent: string | null = null;
  const hadTopic = !!session.topic;
  const staged = stream?.flush(sql);
  if (metrics) metrics.duplicates = duplicates;

  if (persisted > 0) {
    if (staged)
      sql.exec(
        `UPDATE chat_sessions SET message_count = message_count + ?, updated_at = ?,
       stream_ingest_state = ?, last_message_sequence = ?, last_message_sequence_count = message_count + ? WHERE id = ?`,
        persisted,
        now,
        staged.state,
        maximumSequence,
        persisted,
        sessionId
      );
    else
      sql.exec(
        `UPDATE chat_sessions SET message_count = message_count + ?, updated_at = ?, last_message_sequence = ?, last_message_sequence_count = message_count + ? WHERE id = ?`,
        persisted,
        now,
        maximumSequence,
        persisted,
        sessionId
      );

    if (!session.topic) {
      const firstUserMsg = messages.find(
        (m) => m.role === 'user' && (m.origin ?? null) !== 'system'
      );
      if (firstUserMsg) {
        firstUserContent = firstUserMsg.content;
        const truncatedTopic =
          firstUserMsg.content.length > 100
            ? firstUserMsg.content.substring(0, 97) + '...'
            : firstUserMsg.content;
        sql.exec(
          'UPDATE chat_sessions SET topic = ?, updated_at = ? WHERE id = ?',
          truncatedTopic,
          now,
          sessionId
        );
      }
    }

    const wsRow = sql
      .exec('SELECT workspace_id FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];
    workspaceId = wsRow ? parseWorkspaceId(wsRow, 'messages.batch_workspace') : null;
  } else if (staged && staged.state !== session.stream_ingest_state) {
    sql.exec(
      'UPDATE chat_sessions SET stream_ingest_state = ? WHERE id = ?',
      staged.state,
      sessionId
    );
  }

  const remainingCapacity = Math.max(0, maxMessages - startingCount - persisted);
  if (limitReached && persisted === 0 && duplicates === 0 && messages.length > 0) {
    throw new SessionMessageLimitExceededError(maxMessages);
  }

  return {
    persisted,
    duplicates,
    persistedMessages,
    workspaceId,
    firstUserContent,
    hadTopic,
    limitReached,
    maxMessages,
    remainingCapacity,
    broadcastMessages:
      tools.size > 0
        ? [...(staged?.broadcastMessages ?? []), ...tools.values()]
        : (staged?.broadcastMessages ?? persistedMessages),
    appends: staged?.appends ?? [],
  };
}
