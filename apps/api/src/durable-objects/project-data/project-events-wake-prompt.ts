/**
 * Wake prompt construction for materialized ProjectData event batches. The
 * prompt is SAM-authored and IDs-only: event content is read through the event
 * MCP tools, never injected into the prompt.
 */
import type { MessageClass, ProjectEventSubscriptionRecord } from '@simple-agent-manager/shared';

import {
  agentMessageChannelForSubscription,
  agentMessageWakeContent,
} from './agent-message-notice';
import type { ProjectEventWakeSourceTaskGuard } from './project-events-materialization';
import type { AcceptPromptDeliveryInput } from './prompt-delivery';

export type BuildWakePromptInputOptions = {
  batchId: string;
  subscription: ProjectEventSubscriptionRecord;
  sourceTaskGuard: ProjectEventWakeSourceTaskGuard;
  eventIds: string[];
  now: number;
  ttlMs: number;
  maxMessages: number;
  /**
   * Set when an agent-message batch holds an urgent peer message (interrupt and above): the
   * notice is delivered stop-and-deliver with that class. Ignored for other subscriptions.
   */
  urgentAgentMessageClass?: MessageClass | null;
};

export function buildWakePromptInput(
  options: BuildWakePromptInputOptions
): AcceptPromptDeliveryInput {
  const targetSessionId = options.subscription.deliveryPreference.target?.sessionId;
  if (!targetSessionId) throw new Error('Project event wake subscription has no target session');
  const eventIds = options.eventIds.join(', ');
  // runtime_interrupt wakes ride the prompt queue with the `interrupt` mailbox
  // class, so stop-and-deliver may cancel the target's in-flight turn to
  // deliver this batch immediately (urgent delivery phase 1).
  const interruptWake = options.subscription.deliveryPreference.requested === 'runtime_interrupt';
  // runtime_steer wakes add the batch to a running turn (live steering); an idle or
  // sleeping target receives it as an ordinary wake prompt instead.
  const steerWake = options.subscription.deliveryPreference.requested === 'runtime_steer';
  const agentMessageChannel = agentMessageChannelForSubscription(options.subscription);
  const urgentAgentClass = agentMessageChannel ? (options.urgentAgentMessageClass ?? null) : null;
  const urgentPrefix = interruptWake
    ? 'Urgent project event wake (runtime_interrupt) — this batch was important enough ' +
      'to stop an in-flight turn for immediate delivery. If your previous turn was cut ' +
      'short, review the transcript above to see where you left off, then process this ' +
      'batch first. '
    : steerWake
      ? 'Project event update added to your current turn (runtime_steer) — it does not stop ' +
        'your work; fold it in if it is relevant. '
      : '';
  const content = agentMessageChannel
    ? agentMessageWakeContent({
        batchId: options.batchId,
        channel: agentMessageChannel,
        eventIds: options.eventIds,
        urgentClass: urgentAgentClass,
      })
    : urgentPrefix +
      `Project event wake batch ${options.batchId} is ready for this chat. ` +
      `Event IDs: ${eventIds}. ` +
      'Read the events through the ProjectData event MCP tools before acting on their contents. ' +
      'Checkpoint or finish through the normal chat workflow after processing this batch.';
  return {
    deliveryId: options.batchId,
    targetSessionId,
    displayContent: content,
    deliveryContent: content,
    sourceTaskId: options.sourceTaskGuard.taskId,
    senderType: 'system',
    senderId: 'project-data',
    messageClass: urgentAgentClass ?? (interruptWake ? 'interrupt' : 'deliver'),
    // An urgent class never steers: stop-and-deliver is its own path.
    deliveryIntent: steerWake && !urgentAgentClass ? 'steer' : 'queue',
    sourceKind: 'project_event_wake',
    metadata: {
      projectEventWake: true,
      batchId: options.batchId,
      subscriptionId: options.subscription.id,
      eventIds: options.eventIds,
      eventCount: options.eventIds.length,
      createdAt: options.now,
      payloadPolicy: 'ids_only',
      ...(interruptWake || urgentAgentClass ? { runtimeInterrupt: true } : {}),
      ...(steerWake && !urgentAgentClass ? { runtimeSteer: true } : {}),
      ...(urgentAgentClass ? { agentMessageClass: urgentAgentClass } : {}),
      ...(agentMessageChannel ? { agentMessageChannel } : {}),
    },
    ttlMs: options.ttlMs,
    maxMessages: options.maxMessages,
  };
}
