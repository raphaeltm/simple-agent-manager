import type { UserMessageAttribution, UserMessageDelivery } from '@simple-agent-manager/acp-client';
import type { SessionUndeliveredReason } from '@simple-agent-manager/shared';

import type { ChatMessageResponse } from '../../lib/api';
import { maybeJsonRecord } from '../../lib/runtime-validation';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Why a steer became a next-turn message, in the words the chip uses. */
function steerFallbackReason(value: unknown): UserMessageDelivery['reason'] {
  if (value === 'no_running_turn' || value === 'turn_stopping' || value === 'turn_cancelling') {
    return 'turn_finished';
  }
  if (value === 'session_not_awake') return 'agent_asleep';
  if (
    typeof value === 'string' &&
    (value === 'runtime_steering_unsupported' ||
      value.startsWith('adapter_') ||
      value === 'unsupported')
  ) {
    return 'not_supported';
  }
  return 'other';
}

/**
 * What became of a message sent with "Steer now", from the server-written transcript
 * metadata (`deliveryIntent`, then `steerOutcome` once the runtime answered). Queued
 * messages carry no delivery chip.
 */
export function userMessageDelivery(
  message: Pick<ChatMessageResponse, 'role' | 'toolMetadata'>
): UserMessageDelivery | undefined {
  if (message.role !== 'user') return undefined;
  const meta = maybeJsonRecord(message.toolMetadata);
  if (!meta || meta.deliveryIntent !== 'steer') return undefined;
  switch (meta.steerOutcome) {
    case 'steered':
      return { status: 'steered' };
    case 'queued_fallback':
      return { status: 'queued_instead', reason: steerFallbackReason(meta.steerReason) };
    case 'unconfirmed':
      return { status: 'unconfirmed' };
    case 'failed':
      return { status: 'not_delivered' };
    default:
      return { status: 'steering' };
  }
}

/** The server's `deliveryCancelled` reason, as what the bubble says. */
function notDeliveredReason(value: unknown): UserMessageAttribution['notDelivered'] {
  if (value === 'sender_access_revoked') return 'access_removed';
  if (value === 'sender_access_expired') return 'access_expired';
  return undefined;
}

/**
 * Who really sent a user-role transcript row. Durable prompt deliveries carry the sender in
 * their tool metadata (server-written, never client-supplied): a teammate with shared access
 * (`onBehalfOfUserId` is present only for them, on a typed or scheduled message), or a comment
 * someone sent to the agent.
 * The owner's own prompts carry neither and render as the owner's bubble, unchanged.
 *
 * `cancelled` is the session access summary's word that this row was never delivered: the
 * server labels the row too, but a transcript cached before that would not show it.
 */
export function userMessageAttribution(
  message: Pick<ChatMessageResponse, 'role' | 'toolMetadata'>,
  cancelled?: SessionUndeliveredReason
): UserMessageAttribution | undefined {
  if (message.role !== 'user') return undefined;
  const meta = maybeJsonRecord(message.toolMetadata);
  if (!meta || meta.kind !== 'durable_prompt_delivery') return undefined;
  const notDelivered = notDeliveredReason(meta.deliveryCancelled ?? cancelled);

  if (meta.source === 'comment_directive') {
    const author = maybeJsonRecord(meta.author);
    return {
      kind: 'comment',
      senderName: nonEmptyString(meta.senderName),
      commentAuthorName: nonEmptyString(author?.displayName),
      ...(notDelivered ? { notDelivered } : {}),
    };
  }
  // A teammate's own message, typed now or scheduled while they had access. The owner's
  // scheduled messages carry no `onBehalfOfUserId` and stay the owner's bubble.
  if (
    (meta.source === 'user_followup' || meta.source === 'scheduled_action') &&
    nonEmptyString(meta.onBehalfOfUserId)
  ) {
    return {
      kind: 'shared_access',
      senderName: nonEmptyString(meta.senderName),
      ...(meta.source === 'scheduled_action' ? { scheduled: true } : {}),
      ...(notDelivered ? { notDelivered } : {}),
    };
  }
  return undefined;
}
