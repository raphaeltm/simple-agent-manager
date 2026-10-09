import type { ProjectEventRequestedDeliveryMode } from '@simple-agent-manager/shared';

import type { Env } from './types';

export function isProjectEventWakeEnabled(env: Env): boolean {
  return env.PROJECT_EVENT_WAKE_ENABLED === 'true';
}

/**
 * Requested delivery modes whose event wakes ride the durable prompt queue.
 * `runtime_interrupt` maps to the `interrupt` mailbox class (stop-and-deliver
 * phase 1, idea 01M2EPH9WGDYFDQBZCP9QY1FDE): its wakes may cancel the target's
 * in-flight turn so the wake prompt is delivered immediately.
 *
 * Frozen literal tuple: the values are interpolated into the SQL predicate
 * constants below, so both the type and the runtime assertion keep them
 * identifier-safe (a mode containing a quote must fail loudly, never silently
 * become SQL text).
 */
export const PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_MODES = [
  'existing_session_prompt',
  'runtime_interrupt',
] as const satisfies readonly ProjectEventRequestedDeliveryMode[];

for (const mode of PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_MODES) {
  if (!/^[a-z_]+$/.test(mode)) {
    throw new Error(
      `PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_MODES contains a non-identifier-safe value: ${mode}`
    );
  }
}

const promptQueueWakeModeList = PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_MODES.map(
  (mode) => `'${mode}'`
).join(', ');

/** SQL predicate for prompt-queue wake subscriptions, `project_event_subscriptions s`. */
export const PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_SQL = `s.requested_delivery IN (${promptQueueWakeModeList})`;

/** SQL predicate for prompt-queue wake subscriptions on un-aliased rows. */
export const PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_UNALIASED_SQL = `requested_delivery IN (${promptQueueWakeModeList})`;

/**
 * True while subscription `s`'s target chat still has a wake waiting to reach its runtime: a
 * pending prompt-queue batch whose delivery has not expired. A chat holds at most one such wake.
 * Once the runtime accepts it the chat is free for the next wake, acknowledged or not; holding
 * the chat until acknowledgement silenced every other subscription for the 24-hour read grace
 * (idea 01M4E7F6JN191Q4B7H3KRB3N7H).
 *
 * Wake candidate selection and the wake alarm schedule must both exclude occupied targets with
 * this same predicate, so a waiting subscription never re-arms the alarm while it cannot run
 * (`.claude/rules/47` requirement 10). Binds one parameter: the current time. Relies on every
 * prompt-queue batch having `delivery_expires_at` (`insertPromptQueueBatch` sets it, nothing
 * extends it); a NULL would not hold the chat.
 */
export const WAKE_TARGET_HAS_UNDELIVERED_WAKE_SQL = `EXISTS (
  SELECT 1 FROM project_event_delivery_batches occupying
  WHERE occupying.project_id = s.project_id
    AND occupying.delivery_channel = 'prompt_queue'
    AND occupying.target_session_id = s.target_session_id
    AND occupying.state = 'pending'
    AND occupying.delivery_expires_at > ?
)`;
