import type {
  ProjectEventLimits,
  ProjectEventMatchRecord,
  ProjectEventRecord,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';
import { createModuleLogger } from '@simple-agent-manager/worker-core';

import { ProjectEventLimitExceededError } from './project-events-contracts';
import { mapProjectEventSubscription } from './project-events-mappers';
import { filterMatchesProjectEvent, projectEventKeys } from './project-events-normalization';
import { insertMatchIfAbsent } from './project-events-storage-helpers';
import {
  isSelfOriginatedChannelWake,
  subscriptionCanMatchProjectEvent,
} from './project-events-visibility';

const log = createModuleLogger('project_data.project_events.storage');

export function createMatchesForEvent(
  sql: SqlStorage,
  event: ProjectEventRecord,
  now: number,
  limits: ProjectEventLimits,
  requireCompleteFanout = false
): ProjectEventMatchRecord[] {
  const subscriptions = matchingSubscriptionsForEvent(
    sql,
    event,
    now,
    limits,
    requireCompleteFanout
  );
  return subscriptions.map((subscription) => insertMatchIfAbsent(sql, event, subscription, now));
}

/** Read-only admission preflight; shared with stored-event fanout so predicates cannot drift. */
export function matchingSubscriptionsForEvent(
  sql: SqlStorage,
  event: ProjectEventRecord,
  now: number,
  limits: ProjectEventLimits,
  requireCompleteFanout = false
): ProjectEventSubscriptionRecord[] {
  const eventKeys = projectEventKeys(event);
  const placeholders = eventKeys.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT DISTINCT s.*
       FROM project_event_subscriptions s
       JOIN project_event_subscription_match_keys k ON k.subscription_id = s.id
       WHERE s.project_id = ?
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND k.match_key IN (${placeholders})
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT ?`,
      event.projectId,
      now,
      ...eventKeys,
      limits.maxActiveSubscriptionsPerProject + (requireCompleteFanout ? 1 : 0)
    )
    .toArray();

  if (requireCompleteFanout && rows.length > limits.maxActiveSubscriptionsPerProject) {
    throw new ProjectEventLimitExceededError('Channel subscription candidate capacity exceeded');
  }
  const matches: ProjectEventSubscriptionRecord[] = [];
  for (const row of rows) {
    let subscription: ProjectEventSubscriptionRecord;
    try {
      subscription = mapProjectEventSubscription(row);
    } catch (error) {
      log.warn('subscription_candidate_skipped', { error: String(error) });
      continue;
    }
    if (!filterMatchesProjectEvent(subscription.filter, event)) continue;
    if (!subscriptionCanMatchProjectEvent(subscription, event)) continue;
    if (isSelfOriginatedChannelWake(subscription, event)) continue;
    if (requireCompleteFanout && matches.length >= limits.maxMatchesPerEvent) {
      // The enclosing channel transaction rolls back all earlier match writes.
      throw new ProjectEventLimitExceededError('Channel event fanout capacity exceeded');
    }
    matches.push(subscription);
    if (!requireCompleteFanout && matches.length >= limits.maxMatchesPerEvent) break;
  }
  return matches;
}
