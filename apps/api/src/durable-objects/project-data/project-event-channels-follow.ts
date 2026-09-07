import {
  PROJECT_EVENT_CHANNEL_SOURCE,
  PROJECT_EVENT_CHANNEL_TYPE,
  type CatchUpProjectEventChannelInput,
  type FollowProjectEventChannelInput,
  type FollowProjectEventChannelResult,
} from '@simple-agent-manager/shared';

import { channelLimits, channelName } from './project-event-channels-config';
import { decodeChannelCursor, historyHasGap, historyRows, readChannel } from './project-event-channels-storage';
import { createProjectEventSubscription } from './project-events';
import { ProjectEventCursorError, ProjectEventIdempotencyConflictError, ProjectEventLimitExceededError, ProjectEventNotFoundError } from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import { assertProjectBinding, normalizeListLimit } from './project-events-normalization';
import { readVisibleSubscription } from './project-events-pull';
import { insertMatchIfAbsent } from './project-events-storage-helpers';
import { stableStringify } from './project-events-values';
import type { Env } from './types';

type CatchupRow = { subscription_id: string; channel_id: string; after_sequence: number;
  watermark: number; expires_at: number; start_fingerprint: string };

function checkpoint(sql: SqlStorage, subscriptionId: string): CatchupRow | null {
  return sql.exec<CatchupRow>(`SELECT id AS subscription_id, channel_id,
    channel_after_sequence AS after_sequence, channel_watermark AS watermark,
    channel_catchup_expires_at AS expires_at, channel_start_fingerprint AS start_fingerprint
    FROM project_event_subscriptions WHERE id = ? AND channel_id IS NOT NULL`, subscriptionId)
    .toArray()[0] ?? null;
}

/** The live filter and history watermark commit together; no history is loaded here. */
export function followChannel(sql: SqlStorage, env: Env, storedProjectId: string | null,
  input: FollowProjectEventChannelInput): FollowProjectEventChannelResult {
  assertProjectBinding(storedProjectId, input.projectId);
  const row = readChannel(sql, input.projectId, channelName(input.channel, env));
  if (!row) throw new ProjectEventNotFoundError('Project event');
  const now = Date.now();
  const result = createProjectEventSubscription(sql, env, storedProjectId, {
    ...input, filter: { version: 1, source: PROJECT_EVENT_CHANNEL_SOURCE,
      eventType: PROJECT_EVENT_CHANNEL_TYPE, subjectType: 'agent_channel', subjectId: row.name },
  });
  const fingerprint = stableStringify({ channel: row.name, cursor: input.cursor ?? null });
  let state = checkpoint(sql, result.subscription.id);
  if (state) {
    if (state.start_fingerprint !== fingerprint) throw new ProjectEventIdempotencyConflictError();
    if (state.channel_id !== row.id) throw new ProjectEventCursorError('Channel handoff generation is unavailable');
  } else {
    // An existing unrelated subscription must never gain historical access.
    if (result.idempotent) throw new ProjectEventCursorError('Channel handoff checkpoint is unavailable');
    const cursor = input.cursor ? decodeChannelCursor(input.cursor, row, env, now) : null;
    const after = cursor?.after ?? row.lifetime_count;
    state = { subscription_id: result.subscription.id, channel_id: row.id,
      after_sequence: after, watermark: row.lifetime_count,
      expires_at: Math.min(cursor?.expires ?? now + channelLimits(env).cursorTtlMs,
        result.subscription.expiresAt ?? Number.MAX_SAFE_INTEGER),
      start_fingerprint: fingerprint };
    sql.exec(`UPDATE project_event_subscriptions SET channel_id = ?, channel_after_sequence = ?,
      channel_watermark = ?, channel_catchup_expires_at = ?, channel_start_fingerprint = ? WHERE id = ?`,
      state.channel_id, state.after_sequence, state.watermark, state.expires_at, state.start_fingerprint, state.subscription_id);
  }
  if (state.expires_at <= now) throw new ProjectEventCursorError('Channel handoff checkpoint expired');
  return { ...result, watermark: state.watermark, caughtUpThrough: state.after_sequence,
    hasMore: state.after_sequence < state.watermark };
}

/** Matches are canonical and unique; lost replies never lose committed catch-up events. */
export function catchUpChannel(sql: SqlStorage, env: Env, storedProjectId: string | null,
  input: CatchUpProjectEventChannelInput): FollowProjectEventChannelResult {
  assertProjectBinding(storedProjectId, input.projectId);
  const now = Date.now();
  const subscription = readVisibleSubscription(sql, input.projectId, input.subscriptionId, input.visibility, now);
  if (!subscription || subscription.state !== 'active' || (subscription.expiresAt !== null && subscription.expiresAt <= now)) {
    throw new ProjectEventNotFoundError('Event subscription');
  }
  const state = checkpoint(sql, subscription.id);
  if (!state || state.expires_at <= now) throw new ProjectEventCursorError('Channel handoff checkpoint expired or unavailable');
  const channelRow = sql.exec<{ name: string }>(
    'SELECT name FROM project_event_channels WHERE project_id = ? AND id = ?', input.projectId, state.channel_id).toArray()[0];
  const channel = channelRow ? readChannel(sql, input.projectId, channelRow.name) : null;
  if (!channel) throw new ProjectEventCursorError('Channel generation is unavailable');
  const limits = resolveProjectEventLimits(env);
  const limit = normalizeListLimit(input.limit, limits);
  const events = historyRows(sql, channel, state.after_sequence, state.watermark, limit + 1);
  const page = events.slice(0, limit);
  const hasMore = events.length > limit;
  if (historyHasGap(page, state.after_sequence, state.watermark, hasMore)) {
    throw new ProjectEventCursorError('Channel history retention gap; start a new history snapshot');
  }
  for (const { event } of page) {
    const existing = sql.exec(`SELECT id FROM project_event_matches
      WHERE project_id = ? AND event_id = ? AND subscription_id = ? LIMIT 1`,
      input.projectId, event.id, subscription.id).toArray()[0];
    if (!existing) {
      const count = sql.exec(`SELECT id FROM project_event_matches WHERE project_id = ? AND event_id = ? LIMIT ?`,
        input.projectId, event.id, limits.maxMatchesPerEvent).toArray().length;
      if (count >= limits.maxMatchesPerEvent) throw new ProjectEventLimitExceededError('Channel historical event fanout capacity exceeded');
      insertMatchIfAbsent(sql, event, subscription, now);
    }
  }
  const after = hasMore ? page[page.length - 1]!.sequence : state.watermark;
  sql.exec('UPDATE project_event_subscriptions SET channel_after_sequence = ? WHERE id = ?', after, subscription.id);
  return { subscription, idempotent: false, changed: after !== state.after_sequence,
    watermark: state.watermark, caughtUpThrough: after, hasMore };
}
