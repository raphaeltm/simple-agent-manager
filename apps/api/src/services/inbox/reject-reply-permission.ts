/** A queued reply owns its permission rejection, so a failed send never loses the reason. */
import type { VmPromptDeliveryAdapterInput } from '@simple-agent-manager/project-data';
import {
  AcpInteractionBrowserAnswerSchema,
  AcpInteractionIdSchema,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { PromptDeliveryResult } from '../../durable-objects/project-data/prompt-delivery';
import type { Env } from '../../env';
import { answerAgentInteraction } from '../../routes/chat-acp-interactions';

const PermissionReplySchema = v.object({
  interactionId: AcpInteractionIdSchema,
  answer: AcpInteractionBrowserAnswerSchema,
});

/** Metadata comes only from the authorized inbox reply operation, never from the browser. */
export async function rejectInboxReplyPermission(
  env: Env,
  input: Pick<VmPromptDeliveryAdapterInput, 'projectId' | 'claim'>
): Promise<PromptDeliveryResult | null> {
  const { message } = input.claim;
  if (message.sourceKind !== 'inbox_reply') return null;
  const permission = message.metadata?.inboxReplyPermission;
  if (permission === undefined) return null;
  try {
    const parsed = v.parse(PermissionReplySchema, permission);
    if (
      message.senderType !== 'human' ||
      !message.senderId ||
      parsed.answer.decision.kind !== 'selected_option' ||
      !parsed.answer.decision.optionId
    )
      throw new Error('Invalid inbox reply permission provenance');
    // Reuse the prepared answerKey on every attempt: the existing answer path accepts an
    // identical replay but refuses a different decision or a different session's request.
    await answerAgentInteraction(
      env,
      message.senderId,
      input.projectId,
      message.targetSessionId,
      parsed.interactionId,
      parsed.answer
    );
    return null;
  } catch {
    // Never include interaction payloads in persisted delivery diagnostics. A transient
    // rejection failure leaves the already-persisted reason queued for the next attempt.
    return {
      kind: 'retry',
      reason: 'not_ready',
      error: 'Inbox reply permission rejection has not been accepted',
      runtimeIdentity: null,
      capabilities: null,
    };
  }
}
