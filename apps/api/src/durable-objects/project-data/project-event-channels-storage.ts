import {
  isJsonRecord,
  type ProjectEventChannel,
  type ProjectEventChannelHistory,
  type ProjectEventChannelHistoryInput,
  type ProjectEventChannelList,
  type ListProjectEventChannelsInput,
} from '@simple-agent-manager/shared';

import { channelLimits, channelName } from './project-event-channels-config';
import { ProjectEventCursorError, ProjectEventNotFoundError } from './project-events-contracts';
import { mapProjectEvent } from './project-events-mappers';
import { assertProjectBinding, normalizeListLimit } from './project-events-normalization';
import { resolveProjectEventLimits } from './project-events-limits';
import type { Env } from './types';

export type ChannelRow = {
  id: string; project_id: string; name: string; lifetime_count: number;
  last_published_at: number;
};

export function readChannel(sql: SqlStorage, projectId: string, name: string): ChannelRow | null {
  return sql.exec<ChannelRow>(
    'SELECT * FROM project_event_channels WHERE project_id = ? AND name = ?', projectId, name
  ).toArray()[0] ?? null;
}

export function channelDto(row: ChannelRow): ProjectEventChannel {
  return { id: row.id, name: row.name, lifetimeCount: row.lifetime_count, lastPublishedAt: row.last_published_at };
}

/** Live matching uses the stable channel name. Only an unfinished historical
 * catch-up needs to pin its generation; cancelled/expired checkpoints do not. */
export function cleanupEmptyChannels(sql: SqlStorage, env: Env, projectId: string, now: number): void {
  const budget = resolveProjectEventLimits(env).retentionBatchRows;
  // Limit the candidate walk BEFORE reference checks. Ineligible prefixes cannot grow
  // without bound because catalog cardinality itself has a configured hard ceiling.
  const candidates = sql.exec<{ id: string }>(
    `SELECT id FROM project_event_channels WHERE project_id = ?
     AND last_published_at < ? ORDER BY last_published_at, id LIMIT ?`,
    projectId, now - channelLimits(env).catalogIdleTtlMs, budget
  ).toArray();
  for (const { id } of candidates) {
    sql.exec(`DELETE FROM project_event_channels WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM project_events WHERE channel_id = ? LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM project_event_subscriptions WHERE channel_id = ?
        AND lifecycle_state = 'active' AND channel_after_sequence < channel_watermark
        AND channel_catchup_expires_at > ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1)`,
      id, id, id, now, now);
  }
}

export function listChannels(sql: SqlStorage, env: Env, storedProjectId: string | null,
  input: ListProjectEventChannelsInput): ProjectEventChannelList {
  assertProjectBinding(storedProjectId, input.projectId);
  const after = input.after ? channelName(input.after, env) : '';
  const limit = normalizeListLimit(input.limit, resolveProjectEventLimits(env));
  const rows = sql.exec<ChannelRow>(`SELECT * FROM project_event_channels
    WHERE project_id = ? AND name > ? ORDER BY name LIMIT ?`, input.projectId, after, limit + 1).toArray();
  return { channels: rows.slice(0, limit).map(channelDto),
    nextCursor: rows.length > limit ? rows[limit - 1]!.name : null };
}

export type ChannelCursor = { v: 1; p: string; c: string; after: number; until: number; expires: number };

export function encodeChannelCursor(cursor: ChannelCursor): string {
  return btoa(JSON.stringify(cursor));
}

export function decodeChannelCursor(token: string, row: ChannelRow, env: Env, now: number): ChannelCursor {
  try {
    if (token.length > resolveProjectEventLimits(env).subscriptionEventCursorMaxLength) throw new Error();
    const c: unknown = JSON.parse(atob(token));
    if (!isJsonRecord(c) || c.v !== 1 || c.p !== row.project_id || c.c !== row.id ||
      !Number.isSafeInteger(c.after) || !Number.isSafeInteger(c.until) || !Number.isSafeInteger(c.expires) ||
      typeof c.after !== 'number' || typeof c.until !== 'number' || typeof c.expires !== 'number' ||
      c.after < 0 || c.after > c.until || c.until > row.lifetime_count || c.expires <= now ||
      c.expires > now + channelLimits(env).cursorTtlMs) throw new Error();
    return { v: 1, p: c.p, c: c.c, after: c.after, until: c.until, expires: c.expires };
  } catch {
    throw new ProjectEventCursorError('Channel cursor is invalid, expired, or belongs to another generation');
  }
}

export function historyHasGap(events: Array<{ sequence: number }>, after: number, until: number, hasMore: boolean): boolean {
  let expected = after + 1;
  for (const event of events) {
    if (event.sequence !== expected) return true;
    expected++;
  }
  return !hasMore && expected - 1 !== until;
}

export function historyRows(sql: SqlStorage, row: ChannelRow, after: number, until: number, limit: number) {
  return sql.exec(`SELECT * FROM project_events WHERE channel_id = ?
    AND channel_sequence > ? AND channel_sequence <= ? ORDER BY channel_sequence LIMIT ?`,
    row.id, after, until, limit).toArray().map((record) => ({
      sequence: Number(record.channel_sequence), event: mapProjectEvent(record),
    }));
}

export function channelHistory(sql: SqlStorage, env: Env, storedProjectId: string | null,
  input: ProjectEventChannelHistoryInput): ProjectEventChannelHistory {
  assertProjectBinding(storedProjectId, input.projectId);
  const row = readChannel(sql, input.projectId, channelName(input.channel, env));
  if (!row) throw new ProjectEventNotFoundError('Project event');
  const now = Date.now();
  const cursor: ChannelCursor = input.cursor ? decodeChannelCursor(input.cursor, row, env, now) : {
    v: 1, p: input.projectId, c: row.id, after: 0,
    until: row.lifetime_count, expires: now + channelLimits(env).cursorTtlMs,
  };
  const limit = normalizeListLimit(input.limit, resolveProjectEventLimits(env));
  const rows = historyRows(sql, row, cursor.after, cursor.until, limit + 1);
  const events = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { channel: channelDto(row), events, hasMore, watermark: cursor.until,
    retentionGap: historyHasGap(events, cursor.after, cursor.until, hasMore),
    cursor: encodeChannelCursor({ ...cursor,
      after: hasMore ? events[events.length - 1]!.sequence : cursor.until }),
  };
}
