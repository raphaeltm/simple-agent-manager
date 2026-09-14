import type { Env } from './types';

export function isProjectEventWakeEnabled(env: Env): boolean {
  return env.PROJECT_EVENT_WAKE_ENABLED === 'true';
}

/**
 * Requested delivery modes whose event wakes ride the durable prompt queue.
 * `runtime_interrupt` maps to the `interrupt` mailbox class (stop-and-deliver
 * phase 1, idea 01M2EPH9WGDYFDQBZCP9QY1FDE): its wakes may cancel the target's
 * in-flight turn so the wake prompt is delivered immediately.
 */
export const PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_MODES: readonly string[] = [
  'existing_session_prompt',
  'runtime_interrupt',
];

const promptQueueWakeModeList = PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_MODES.map(
  (mode) => `'${mode}'`
).join(', ');

/** SQL predicate for prompt-queue wake subscriptions, `project_event_subscriptions s`. */
export const PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_SQL = `s.requested_delivery IN (${promptQueueWakeModeList})`;

/** SQL predicate for prompt-queue wake subscriptions on un-aliased rows. */
export const PROMPT_QUEUE_WAKE_REQUESTED_DELIVERY_UNALIASED_SQL = `requested_delivery IN (${promptQueueWakeModeList})`;
