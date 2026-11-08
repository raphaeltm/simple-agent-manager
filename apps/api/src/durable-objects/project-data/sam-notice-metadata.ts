/**
 * Where SAM notices enter `chat_messages.tool_metadata`. A notice renders in the chat as a
 * message from SAM, so only trusted server code may write one: every path that stores
 * caller-supplied metadata drops the key.
 */
import {
  type PromptDeliveryIntent,
  SAM_NOTICE_METADATA_KEY,
  SAM_RUNTIME_REPORTED_KEY,
} from '@simple-agent-manager/shared';

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
 * it either. The text check only skips parsing when the key cannot be present: JSON can spell
 * a key with `\uXXXX` escapes (`"sam\u004eotice"` parses to `samNotice`), so any escape
 * means parse.
 */
export function withoutSamNotice(
  toolMetadata: string | null,
  sessionId: string,
  messageId: string
): string | null {
  if (
    !toolMetadata ||
    (!toolMetadata.includes(SAM_NOTICE_METADATA_KEY) && !toolMetadata.includes('\\u'))
  ) {
    return toolMetadata;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolMetadata);
  } catch {
    return toolMetadata;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return toolMetadata;
  if (!(SAM_NOTICE_METADATA_KEY in parsed)) return toolMetadata;
  const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  delete rest[SAM_NOTICE_METADATA_KEY];
  log.warn('messages.batch_sam_notice_dropped', { sessionId, messageId, action: 'dropped' });
  return JSON.stringify(rest);
}

/**
 * Marks a `system` row from a runtime message batch as a workspace report, so the chat does
 * not show it as SAM's own words (see `SAM_RUNTIME_REPORTED_KEY`). Applied after storage
 * bounding, which may rebuild the metadata, so the mark always survives. Metadata that is not
 * a JSON object is replaced: the UI could not read it anyway.
 */
export function markRuntimeReported(toolMetadata: string | null): string {
  let parsed: unknown = null;
  try {
    parsed = toolMetadata ? JSON.parse(toolMetadata) : null;
  } catch {
    parsed = null;
  }
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return JSON.stringify({ ...record, [SAM_RUNTIME_REPORTED_KEY]: true });
}
