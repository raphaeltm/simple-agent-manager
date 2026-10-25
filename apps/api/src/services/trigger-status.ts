import type { TriggerStatus } from '@simple-agent-manager/shared';
import { type SQL, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { cronToNextFire } from './cron-utils';

/** The trigger columns a status change rewrites. An absent key leaves the column alone. */
export interface TriggerStatusUpdates {
  status: TriggerStatus;
  nextFireAt?: string | null;
  autoPauseResetSequence?: SQL;
}

/**
 * The column updates that move a trigger to `status`. Shared by the REST PATCH route and the
 * Connector's schedule update, so pausing or resuming means the same thing on both.
 *
 * - Leaving `active` clears `nextFireAt`, so the cron sweep cannot fire a paused trigger.
 * - Returning to `active` from another status restarts the consecutive-failure window that
 *   auto-pause counts (`trigger-admission.ts` `consecutiveFailureCount`) at the next execution,
 *   so failures from before the pause cannot pause it again on the first new failure.
 * - An active cron trigger gets its next fire time from its schedule; other sources keep theirs.
 *
 * `trigger` is the schedule the row will have after the update: a caller that also changes the
 * cron expression or zone passes the new values, so the next fire comes from them.
 */
export function triggerStatusUpdates(
  trigger: Pick<schema.TriggerRow, 'status' | 'sourceType' | 'cronExpression' | 'cronTimezone'>,
  status: TriggerStatus,
  now: Date = new Date()
): TriggerStatusUpdates {
  const updates: TriggerStatusUpdates = { status };
  if (status === 'active' && trigger.status !== 'active') {
    updates.autoPauseResetSequence = sql`${schema.triggers.nextExecutionSequence}`;
  }
  if (status !== 'active') updates.nextFireAt = null;
  if (status === 'active' && trigger.sourceType === 'cron' && trigger.cronExpression) {
    updates.nextFireAt = cronToNextFire(trigger.cronExpression, trigger.cronTimezone ?? 'UTC', now);
  }
  return updates;
}
