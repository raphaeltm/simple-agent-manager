import {
  type ChatMessageAppend,
  compareMessagePositions,
  type MessagePosition,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { DEFAULT_MESSAGE_BOOKKEEPING, flushMessageBookkeeping } from './message-bookkeeping';
import { DEFAULT_BOOKKEEPING_SUMMARY_RETRY } from './message-bookkeeping-summary-queue';

export const DEFAULT_MESSAGE_MERGE_CONFIG = {
  ...DEFAULT_BOOKKEEPING_SUMMARY_RETRY,
  bookkeepingSealLeaseMs: 60_000,
  bookkeepingSealMaxSessions: 10_000,
  enabled: false,
  maxRowBytes: 64 * 1024,
  recentIds: 200,
  bookkeepingIntervalMs: DEFAULT_MESSAGE_BOOKKEEPING.intervalMs,
  bookkeepingFlushBatchSize: DEFAULT_MESSAGE_BOOKKEEPING.flushBatchSize,
} as const;
export interface MessageMergeConfig {
  enabled: boolean;
  maxRowBytes: number;
  recentIds: number;
  bookkeepingIntervalMs?: number;
  bookkeepingFlushBatchSize?: number;
  bookkeepingSealLeaseMs?: number;
  bookkeepingSealMaxSessions?: number;
  bookkeepingSummaryRetryMs?: number;
  bookkeepingSummaryMaxAttempts?: number;
  bookkeepingSummaryMaxResidenceMs?: number;
}
/** Supplied by the authenticated callback adapter, never by the message body. */
export interface MessageIngestSource {
  workspaceId: string;
  callbackGeneration: string | null;
  /** Absent on deployed reporters that cannot distinguish a recreated outbox. */
  outboxIncarnation?: string;
}
export interface StoredBatchMessage {
  id: string;
  role: string;
  content: string;
  toolMetadata: unknown;
  createdAt: number;
  sequence: number;
  origin: string | null;
}
const OpenRow = v.object({
  id: v.string(),
  sequence: v.number(),
  createdAt: v.number(),
  lastSequence: v.number(),
  lastCreatedAt: v.number(),
  length: v.number(),
  bytes: v.number(),
  origin: v.nullable(v.string()),
  turn: v.nullable(v.number()),
  messageCount: v.number(),
});
const IngestState = v.object({
  source: v.string(),
  through: v.number(),
  maxSequence: v.number(),
  lastCreatedAt: v.optional(v.number(), 0),
  recent: v.array(v.string()),
  // Retain exact replay frontiers when a delayed request belongs to an older
  // outbox. Never evict them to make room for a new source: fall back instead.
  retired: v.optional(v.record(v.string(), v.number()), {}),
  open: v.nullable(OpenRow),
});
export type MessageIngestState = v.InferOutput<typeof IngestState>;

export function readMessageIngestState(value: unknown): MessageIngestState | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Invalid message ingest state');
  return v.parse(IngestState, JSON.parse(value));
}

/** Seal only a new canonical row; historical transcript rows are never changed. */
export function sealMessageStream(sql: SqlStorage, sessionId: string): void {
  flushMessageBookkeeping(sql, sessionId);
  sql.exec(
    `UPDATE chat_sessions SET stream_ingest_state = json_set(stream_ingest_state, '$.open', NULL)
     WHERE json_extract(stream_ingest_state, '$.open') IS NOT NULL AND id = ?`,
    sessionId
  );
}

/**
 * One synchronous persistence transaction. The source frontier handles historical
 * replays; recent full-batch IDs bridge credential rotation with a retained outbox.
 * Direct browser writes never evict these receipts. No per-chunk SQL rows or wire IDs.
 */
export class MessageStreamBatch {
  readonly state: MessageIngestState;
  sealed = false;
  private readonly initialThrough: number;
  private readonly priorRecent: Set<string>;
  private readonly seen = new Set<string>();
  private readonly consumed: string[] = [];
  private readonly inserts = new Map<string, StoredBatchMessage>();
  private readonly metadata = new Map<string, string | null>();
  private readonly updates = new Map<string, ChatMessageAppend>();
  private readonly canSequence: boolean;
  private readonly canMerge: boolean;
  private readonly retiredSource: string | null;
  private latestPosition: MessagePosition | null;
  private messageCount: number;

  constructor(
    private readonly sessionId: string,
    private readonly config: MessageMergeConfig,
    previous: MessageIngestState | null,
    source: MessageIngestSource | undefined,
    sequences: readonly (number | undefined)[],
    private readonly turn: number | null,
    latestPosition: MessagePosition | null,
    materializedThrough: { createdAt: number; sequence: number } | null,
    messageIds: readonly string[],
    messageCount: number
  ) {
    this.latestPosition = latestPosition;
    this.messageCount = messageCount;
    const sourceKey = source?.outboxIncarnation
      ? JSON.stringify([source.workspaceId, source.callbackGeneration, source.outboxIncarnation])
      : null;
    const validSequence =
      sourceKey !== null &&
      sequences.every(
        (sequence, index) =>
          typeof sequence === 'number' &&
          Number.isSafeInteger(sequence) &&
          sequence > 0 &&
          (index === 0 || sequence > (sequences[index - 1] ?? Number.MAX_SAFE_INTEGER))
      );
    const sameSource = sourceKey !== null && previous?.source === sourceKey;
    const retired = { ...(previous?.retired ?? {}) };
    this.retiredSource = sourceKey !== null && Object.hasOwn(retired, sourceKey) ? sourceKey : null;
    if (sourceKey && !sameSource && !this.retiredSource && previous?.source)
      retired[previous.source] = previous.through;
    this.priorRecent = new Set(previous?.recent ?? []);
    const candidate: MessageIngestState = {
      source: validSequence && !this.retiredSource ? (sourceKey ?? '') : (previous?.source ?? ''),
      through: validSequence && !sameSource && !this.retiredSource ? 0 : (previous?.through ?? 0),
      maxSequence: previous?.maxSequence ?? 0,
      recent: previous?.recent ?? [],
      retired,
      lastCreatedAt: previous?.lastCreatedAt ?? 0,
      open: sameSource ? (previous?.open ?? null) : null,
    };
    const receipt = new Set(candidate.recent);
    for (const id of messageIds) {
      receipt.delete(id);
      receipt.add(id);
    }
    const bounded = [...receipt].slice(-Math.max(config.recentIds, messageIds.length));
    // Arbitrary callback IDs must never turn one session row into an oversized
    // receipt. If the complete retry window cannot fit, retain ordinary rows.
    const receiptFits =
      new TextEncoder().encode(JSON.stringify({ ...candidate, recent: bounded })).byteLength <=
      config.maxRowBytes;
    // An already-known frontier must remain usable even if an operator lowers
    // the cap. Unknown incarnations that cannot fit retain per-ID stored rows.
    this.canSequence = validSequence && (sameSource || this.retiredSource !== null || receiptFits);
    this.state = this.canSequence
      ? candidate
      : {
          ...candidate,
          source: previous?.source ?? '',
          through: previous?.through ?? 0,
          retired: previous?.retired ?? {},
          open: null,
        };
    this.initialThrough = this.canSequence
      ? sameSource
        ? (previous?.through ?? 0)
        : this.retiredSource
          ? (retired[this.retiredSource] ?? 0)
          : 0
      : 0;
    this.canMerge = config.enabled && this.canSequence && !this.retiredSource && receiptFits;
    const open = this.state.open;
    if (
      !this.canMerge ||
      open?.id !== latestPosition?.id ||
      open?.messageCount !== messageCount ||
      open?.turn !== turn ||
      (open &&
        materializedThrough &&
        (open.createdAt < materializedThrough.createdAt ||
          (open.createdAt === materializedThrough.createdAt &&
            open.sequence <= materializedThrough.sequence)))
    ) {
      this.sealed = previous?.open != null;
      this.state.open = null;
    }
  }

  isDuplicate(messageId: string, sequence?: number): boolean {
    const duplicate =
      this.seen.has(messageId) ||
      this.priorRecent.has(messageId) ||
      (this.canSequence && typeof sequence === 'number' && sequence <= this.initialThrough);
    this.seen.add(messageId);
    return duplicate;
  }

  consume(messageId: string, sequence?: number): void {
    this.consumed.push(messageId);
    if (this.canSequence && typeof sequence === 'number') {
      if (this.retiredSource)
        this.state.retired[this.retiredSource] = Math.max(
          this.state.retired[this.retiredSource] ?? 0,
          sequence
        );
      else this.state.through = Math.max(this.state.through, sequence);
    }
  }

  /** Role/metadata/origin/gaps/cap/turn boundaries end a run, even on duplicate user echoes. */
  boundary(role: string, toolMetadata: string | null): void {
    if (role !== 'assistant' || toolMetadata !== null) {
      this.sealed ||= this.state.open != null;
      this.state.open = null;
    }
  }

  stage(
    message: StoredBatchMessage,
    sequence: number | undefined,
    storedToolMetadata: string | null
  ): string {
    this.messageCount++;
    this.state.maxSequence = Math.max(this.state.maxSequence, message.sequence);
    this.state.lastCreatedAt = Math.max(this.state.lastCreatedAt, message.createdAt);
    const contentBytes = new TextEncoder().encode(JSON.stringify(message.content)).byteLength - 2;
    const open = this.state.open;
    const eligible = this.canMerge && message.role === 'assistant' && message.toolMetadata === null;
    if (
      eligible &&
      open &&
      open.origin === message.origin &&
      sequence === open.lastSequence + 1 &&
      message.createdAt >= open.lastCreatedAt &&
      open.bytes + contentBytes <= this.config.maxRowBytes
    ) {
      const existing = this.inserts.get(open.id);
      if (existing) existing.content += message.content;
      else {
        const update = this.updates.get(open.id);
        if (update) {
          update.content += message.content;
          update.revision += message.content.length;
        } else
          this.updates.set(open.id, {
            id: open.id,
            sessionId: this.sessionId,
            content: message.content,
            offset: open.length,
            revision: open.length + message.content.length,
          });
      }
      open.length += message.content.length;
      open.bytes += contentBytes;
      open.lastSequence = sequence;
      open.lastCreatedAt = message.createdAt;
      open.messageCount = this.messageCount;
      return open.id;
    }
    this.sealed ||= this.state.open != null;
    this.inserts.set(message.id, { ...message });
    this.metadata.set(message.id, storedToolMetadata);
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...message, sessionId: this.sessionId })
    ).byteLength;
    const newest =
      !this.latestPosition || compareMessagePositions(message, this.latestPosition) >= 0;
    if (newest) this.latestPosition = message;
    this.state.open =
      eligible && newest && bytes <= this.config.maxRowBytes
        ? {
            id: message.id,
            sequence: message.sequence,
            createdAt: message.createdAt,
            lastSequence: sequence ?? message.sequence,
            lastCreatedAt: message.createdAt,
            length: message.content.length,
            bytes,
            origin: message.origin,
            turn: this.turn,
            messageCount: this.messageCount,
          }
        : null;
    return message.id;
  }

  flush(sql: SqlStorage): {
    broadcastMessages: StoredBatchMessage[];
    appends: ChatMessageAppend[];
    state: string;
  } {
    for (const message of this.inserts.values())
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        this.sessionId,
        message.role,
        message.content,
        this.metadata.get(message.id) ?? null,
        message.createdAt,
        message.sequence,
        message.origin
      );
    for (const append of this.updates.values()) {
      const changed = sql
        .exec(
          'UPDATE chat_messages SET content = content || ? WHERE id = ? AND session_id = ? RETURNING id',
          append.content,
          append.id,
          this.sessionId
        )
        .toArray();
      if (changed.length !== 1) throw new Error('Canonical message append lost its stored base');
    }
    // Refresh duplicates too: a failed local outbox DELETE can resend one old ID
    // alongside arbitrarily many newer batches. Keeping only NEW IDs loses it.
    const recent = new Set(this.state.recent);
    for (const id of this.consumed) {
      if (this.canMerge || recent.has(id)) {
        recent.delete(id);
        recent.add(id);
      }
    }
    const retained = Math.max(
      this.config.recentIds,
      this.consumed.length,
      this.canMerge ? 0 : this.state.recent.length
    );
    this.state.recent = [...recent].slice(-retained);
    return {
      broadcastMessages: [...this.inserts.values()],
      appends: [...this.updates.values()],
      state: JSON.stringify(this.state),
    };
  }
}
