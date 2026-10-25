/**
 * `minWakeIntervalSeconds`, shared by follow_event_channel and create_project_event_subscription:
 * the agent's chosen minimum spacing between wakes for one subscription. ProjectData validates the
 * range and raises the value to the platform wake cooldown (`normalizeSubscriptionInput`).
 */
import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';

import { AppError } from '../../middleware/error';

const defaultCooldownSeconds = DEFAULT_PROJECT_EVENT_LIMITS.wakeSubscriptionCooldownMs / 1000;
const defaultLifetimeHours = DEFAULT_PROJECT_EVENT_LIMITS.wakeSubscriptionLifetimeMs / 3_600_000;

export const MIN_WAKE_INTERVAL_SECONDS_PROPERTY = {
  type: 'integer',
  minimum: 1,
  description:
    'Optional: wake this chat at most once per this many seconds (600 = at most every 10 min). ' +
    'The first event after a quiet spell still wakes you promptly; later events are bundled into ' +
    'the next wake, timed from when you received the previous one. Omit to wake on every event ' +
    `after the platform cooldown (default ${defaultCooldownSeconds} s), which is also the minimum. ` +
    `Wake delivery modes only; at most the wake lifetime (default ${defaultLifetimeHours} h).`,
} as const;

/** Returns milliseconds, or undefined when the argument is absent. */
export function parseMinWakeIntervalSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppError(400, 'BAD_REQUEST', 'minWakeIntervalSeconds must be a positive integer');
  }
  return value * 1000;
}
