import type { PromptDeliveryIntent, SteerOutcome } from '@simple-agent-manager/shared';

import { maybeJsonRecord } from './runtime-validation';

/**
 * A `mailbox.delivery_updated` broadcast: what became of one durable message. Only
 * fields the transcript row shows are kept; `promptMessageId` names that row.
 */
export interface PromptDeliveryUpdate {
  promptMessageId: string;
  deliveryIntent: PromptDeliveryIntent;
  deliveryState: string;
  steerOutcome: SteerOutcome | null;
  steerReason: string | null;
}

export function parsePromptDeliveryUpdate(value: unknown): PromptDeliveryUpdate | null {
  const record = maybeJsonRecord(value);
  if (!record || typeof record.promptMessageId !== 'string' || !record.promptMessageId) return null;
  const steerOutcome =
    record.steerOutcome === 'steered' || record.steerOutcome === 'queued_fallback'
      ? record.steerOutcome
      : null;
  return {
    promptMessageId: record.promptMessageId,
    deliveryIntent: record.deliveryIntent === 'steer' ? 'steer' : 'queue',
    deliveryState: typeof record.deliveryState === 'string' ? record.deliveryState : '',
    steerOutcome,
    steerReason: typeof record.steerReason === 'string' ? record.steerReason : null,
  };
}

/**
 * The tool-metadata fields an update sets on its transcript row, matching what the
 * server labels on the persisted row (`labelSteerOutcomeOnTranscript`). A failure is
 * labelled whatever the update's intent, because a steer that fell back to the queue
 * reports `queue`; only rows sent as a steer render the label (`userMessageDelivery`).
 */
export function deliveryUpdateMetadataPatch(
  update: PromptDeliveryUpdate
): Record<string, unknown> | null {
  if (update.steerOutcome) {
    return { steerOutcome: update.steerOutcome, steerReason: update.steerReason };
  }
  if (update.deliveryState === 'ambiguous') return { steerOutcome: 'unconfirmed' };
  if (update.deliveryState === 'failed') return { steerOutcome: 'failed' };
  return null;
}
