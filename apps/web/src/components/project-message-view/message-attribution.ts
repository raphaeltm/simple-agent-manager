import type { UserMessageAttribution } from '@simple-agent-manager/acp-client';

import type { ChatMessageResponse } from '../../lib/api';
import { maybeJsonRecord } from '../../lib/runtime-validation';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Who really sent a user-role transcript row. Durable prompt deliveries carry the sender in
 * their tool metadata (server-written, never client-supplied): a teammate with shared access
 * (`onBehalfOfUserId` is present only for them), or a comment someone sent to the agent.
 * The owner's own prompts carry neither and render as the owner's bubble, unchanged.
 */
export function userMessageAttribution(
  message: Pick<ChatMessageResponse, 'role' | 'toolMetadata'>
): UserMessageAttribution | undefined {
  if (message.role !== 'user') return undefined;
  const meta = maybeJsonRecord(message.toolMetadata);
  if (!meta || meta.kind !== 'durable_prompt_delivery') return undefined;
  const notDelivered = meta.deliveryCancelled === 'sender_access_revoked';

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
