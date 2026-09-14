/**
 * Delivery-content composition for urgent (interrupt-class and above) durable
 * messages — stop-and-deliver phase 1 (idea 01M2EPH9WGDYFDQBZCP9QY1FDE).
 *
 * The transcript row keeps the sender's raw message (`displayContent`), but the
 * prompt actually submitted to the target agent (`deliveryContent`) is wrapped
 * with the context the target needs to act correctly: why its turn may have
 * been cut short, who sent the directive, and the directive itself.
 */
import type { MessageClass } from '@simple-agent-manager/shared';

export interface UrgentDeliveryContentInput {
  messageClass: MessageClass;
  message: string;
  senderTaskId?: string | null;
}

/**
 * Compose the prompt content for an urgent durable message. Wording is honest
 * for both target states: the turn stop is conditional on a turn actually being
 * in flight, which the sender cannot know at accept time.
 */
export function composeUrgentDeliveryContent(input: UrgentDeliveryContentInput): string {
  const sender = input.senderTaskId ? ` from task ${input.senderTaskId}` : '';
  const header = `[Urgent agent message — class: ${input.messageClass}]`;
  const context =
    `This message was sent with an urgency class that stops any in-flight turn so it is ` +
    `delivered immediately${sender}. If your previous turn was cut short mid-task, that is ` +
    `why: review the transcript above to see where you left off, reconcile any in-flight ` +
    `work, then act on the directive below.`;
  return `${header}\n${context}\n\nDirective:\n${input.message}`;
}
