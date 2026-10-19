import type { UserMessageAttribution } from '@simple-agent-manager/acp-client';
import type { SessionUndeliveredReason } from '@simple-agent-manager/shared';

import type { ChatMessageResponse } from '../../lib/api';
import { maybeJsonRecord } from '../../lib/runtime-validation';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
 * (`onBehalfOfUserId` is present only for them), or a comment someone sent to the agent.
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
  if (meta.source === 'user_followup' && nonEmptyString(meta.onBehalfOfUserId)) {
    return {
      kind: 'shared_access',
      senderName: nonEmptyString(meta.senderName),
      ...(notDelivered ? { notDelivered } : {}),
    };
  }
  return undefined;
}
