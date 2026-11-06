/**
 * Where SAM notices enter `chat_messages.tool_metadata`. A notice renders in the chat as a
 * message from SAM, so only trusted server code may write one: every path that stores
 * caller-supplied metadata drops the key.
 */
import { type PromptDeliveryIntent, SAM_NOTICE_METADATA_KEY } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import type { AcceptPromptDeliveryInput } from './prompt-delivery';

/**
 * The `tool_metadata` stored on a durable delivery's transcript row and sent in its
 * `message.new` broadcast. Caller metadata can come from an agent (send_durable_message), so
 * a notice inside it is dropped; the notice comes only from `input.notice`.
 */
export function promptDeliveryToolMetadata(
  input: Pick<AcceptPromptDeliveryInput, 'metadata' | 'notice' | 'sourceKind' | 'targetSessionId'>,
  deliveryId: string,
  deliveryIntent: PromptDeliveryIntent
): Record<string, unknown> {
  const { [SAM_NOTICE_METADATA_KEY]: forged, ...callerMetadata } = input.metadata ?? {};
  if (forged !== undefined) {
    log.warn('prompt_delivery.caller_notice_dropped', {
      targetSessionId: input.targetSessionId,
      sourceKind: input.sourceKind,
      deliveryId,
      action: 'dropped',
    });
  }
  return {
    ...callerMetadata,
    source: input.sourceKind,
    kind: 'durable_prompt_delivery',
    deliveryId,
    ...(deliveryIntent === 'steer' ? { deliveryIntent } : {}),
    ...(input.notice ? { [SAM_NOTICE_METADATA_KEY]: input.notice } : {}),
  };
}

/**
 * VM-agent message batches carry runtime-supplied tool metadata (a JSON string); drop any
 * notice in it. Unparseable metadata is returned unchanged: the UI cannot read a notice from
 * it either.
 */
export function withoutSamNotice(
  toolMetadata: string | null,
  sessionId: string,
  messageId: string
): string | null {
  if (!toolMetadata || !toolMetadata.includes(SAM_NOTICE_METADATA_KEY)) return toolMetadata;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolMetadata);
  } catch {
    return toolMetadata;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return toolMetadata;
  if (!(SAM_NOTICE_METADATA_KEY in parsed)) return toolMetadata;
  const { [SAM_NOTICE_METADATA_KEY]: _dropped, ...rest } = parsed as Record<string, unknown>;
  log.warn('messages.batch_sam_notice_dropped', { sessionId, messageId, action: 'dropped' });
  return JSON.stringify(rest);
}
