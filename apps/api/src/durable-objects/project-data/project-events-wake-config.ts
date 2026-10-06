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
