import {
  type ListProjectEventChannelSubscribersInput,
  PROJECT_EVENT_CHANNEL_SOURCE,
  PROJECT_EVENT_CHANNEL_TYPE,
  PROJECT_EVENT_SUBSCRIPTION_STATES,
  type ProjectEventChannelSubscriberList,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { channelName } from './project-event-channels-config';
import { ProjectEventCursorError, ProjectEventValidationError } from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import { mapProjectEventSubscription } from './project-events-mappers';
import {
  assertProjectBinding,
  normalizeListLimit,
  normalizeProjectId,
} from './project-events-normalization';
import { normalizeText } from './project-events-values';
import type { Env } from './types';

/** No expiry sweep or delivery side effects: effective state is computed at read time. */
export function listChannelSubscribers(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: ListProjectEventChannelSubscribersInput
): ProjectEventChannelSubscriberList {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const channel = channelName(input.channel, env);
  const state = input.state ?? 'active';
  if (state !== 'any' && !PROJECT_EVENT_SUBSCRIPTION_STATES.includes(state)) {
    throw new ProjectEventValidationError('state must be active, cancelled, expired, or any');
  }
  const limit = Math.min(normalizeListLimit(input.limit, limits), limits.listLimitMax);
  let after = '';
  if (input.cursor !== undefined) {
    try {
      const cursor = v.parse(
        v.strictTuple([
          v.literal(1),
          v.literal(projectId),
          v.literal(channel),
          v.literal(state),
          v.string(),
        ]),
        JSON.parse(normalizeText(input.cursor, 'cursor', limits.maxMetadataBytes))
      );
      after = normalizeText(cursor[4], 'cursor subscription', limits.maxFilterStringBytes);
    } catch {
      throw new ProjectEventCursorError('Invalid subscriber cursor');
    }
  }
  const now = Date.now();
  const effectiveState = `CASE WHEN lifecycle_state = 'active' AND expires_at <= ?
    THEN 'expired' ELSE lifecycle_state END`;
  const params: unknown[] = [projectId, after];
  let where = 's.project_id = ? AND s.id > ?';
  if (state !== 'any') {
    where += ` AND (${effectiveState}) = ?`;
    params.push(now, state);
  }
  // Match each exact/set/omitted dimension before LIMIT. Never use channel_id:
  // broad subscriptions and subscriptions from older catalog generations also match.
  const fields = {
    source: PROJECT_EVENT_CHANNEL_SOURCE,
    eventType: PROJECT_EVENT_CHANNEL_TYPE,
    subjectType: 'agent_channel',
    subjectId: channel,
    severity: 'info',
  };
  for (const [field, value] of Object.entries(fields)) {
    where += ` AND (json_type(s.filter_json, '$.${field}') IS NULL OR EXISTS (
      SELECT 1 FROM json_each(s.filter_json, '$.${field}') WHERE value = ?
    ))`;
    params.push(value);
  }
  const rows = sql
    .exec(
      `SELECT s.* FROM project_event_subscriptions s WHERE ${where} ORDER BY s.id LIMIT ?`,
      ...params,
      limit + 1
    )
    .toArray();
  const subscribers = rows.slice(0, limit).map((row) => {
    const subscription = mapProjectEventSubscription(row);
    return {
      subscriptionId: subscription.id,
      owner: subscription.owner,
      target: subscription.deliveryPreference.target ?? {},
      state:
        subscription.state === 'active' &&
        subscription.expiresAt !== null &&
        subscription.expiresAt <= now
          ? ('expired' as const)
          : subscription.state,
      expiresAt: subscription.expiresAt,
      createdAt: subscription.createdAt,
    };
  });
  const hasMore = rows.length > limit;
  const last = subscribers.at(-1);
  return {
    channel,
    subscribers,
    hasMore,
    nextCursor:
      hasMore && last ? JSON.stringify([1, projectId, channel, state, last.subscriptionId]) : null,
  };
}
