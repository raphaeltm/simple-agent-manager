import type { PromptDeliveryIntent } from '@simple-agent-manager/shared';
import type { Dispatch, SetStateAction } from 'react';

import type { ChatMessageResponse, ChatSessionResponse } from '../../lib/api';
import { resetIdleTimer } from '../../lib/api';

/** A follow-up to an idle session pushes its cleanup deadline out (best effort). */
export function refreshIdleCleanupAfterSend(
  projectId: string,
  sessionId: string,
  setSession: Dispatch<SetStateAction<ChatSessionResponse | null>>
): void {
  resetIdleTimer(projectId, sessionId)
    .then((result) => {
      if (!result.cleanupAt) return;
      setSession((prev) =>
        prev
          ? ({
              ...prev,
              cleanupAt: result.cleanupAt,
              isIdle: false,
              agentCompletedAt: null,
            } as ChatSessionResponse)
          : prev
      );
    })
    .catch(() => {});
}

/**
 * The optimistic row shown until the server's transcript row arrives. A steer carries
 * its intent so the row shows "Steering…" from the moment it is sent.
 */
export function optimisticUserMessage(
  sessionId: string,
  content: string,
  deliveryIntent: PromptDeliveryIntent
): ChatMessageResponse {
  return {
    id: `optimistic-${crypto.randomUUID()}`,
    sessionId,
    role: 'user',
    content,
    toolMetadata:
      deliveryIntent === 'steer' ? { kind: 'durable_prompt_delivery', deliveryIntent } : null,
    createdAt: Date.now(),
  };
}
