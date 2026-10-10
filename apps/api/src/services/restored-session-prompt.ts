/**
 * The first prompt of a VM wake whose snapshot restore resumed the saved agent session.
 *
 * A fresh start receives the wake's instruction as its initial prompt. A session restored
 * through LoadSession never does (`initialPromptSent: false` from `startSamAwareAgentSession`).
 * When a queued message caused the wake, that message is its prompt; when nothing is queued
 * (a task whose runtime was lost), the TaskRunner queues this prompt through durable prompt
 * delivery. The VM wake handoff hold (`isVmWakeHandoffPending` in `vm-prompt-delivery-target.ts`)
 * keeps it queued until `transitionToInProgress` commits the handoff, and the committed wake's
 * readiness signal (`signalSessionWakeReady`) makes it due.
 */
import { resolveDurableExecutionConfig } from '../durable-objects/project-data/durable-execution-config';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

/** Sender recorded on the queued prompt and its transcript row. */
export const RESTORED_SESSION_PROMPT_SENDER_ID = 'session-recovery';

/**
 * Shown instead when nothing would deliver the prompt: `processPromptDeliveryAlarm` does no
 * work while durable delivery is disabled, and a silent idle agent is the failure this module
 * exists to prevent (policy fe8b57c6).
 */
export const RESTORED_SESSION_PROMPT_UNDELIVERABLE_NOTICE =
  'SAM restored this task after its workspace was stopped, but could not tell the agent to continue: durable prompt delivery is disabled on this installation. Send a message to continue the task.';

/**
 * One delivery per wake. Every wake allocates a new agent session (`TaskRunner.reactivate`
 * resets `stepResults`), and a retried TaskRunner step reuses its own, so a retry converges on
 * the same delivery instead of queueing a second prompt.
 */
export function restoredSessionPromptDeliveryId(agentSessionId: string): string {
  return `checkpoint-continuation-${agentSessionId}`;
}

export interface QueueRestoredSessionPromptInput {
  projectId: string;
  chatSessionId: string;
  /** The waking task; the delivery is valid only while it is live and owns the chat. */
  taskId: string;
  agentSessionId: string;
  prompt: string;
}

export async function queueRestoredSessionPrompt(
  env: Env,
  input: QueueRestoredSessionPromptInput
): Promise<void> {
  const config = resolveDurableExecutionConfig(env);
  const deliveryId = restoredSessionPromptDeliveryId(input.agentSessionId);
  const logContext = {
    projectId: input.projectId,
    chatSessionId: input.chatSessionId,
    taskId: input.taskId,
    agentSessionId: input.agentSessionId,
    deliveryId,
  };
  if (!config.deliveryEnabled) {
    await projectDataService.persistMessage(
      env,
      input.projectId,
      input.chatSessionId,
      'system',
      RESTORED_SESSION_PROMPT_UNDELIVERABLE_NOTICE,
      null,
      `${deliveryId}-undeliverable`
    );
    log.warn('restored_session_prompt.delivery_disabled', logContext);
    return;
  }
  await projectDataService.acceptPromptDelivery(env, input.projectId, {
    deliveryId,
    targetSessionId: input.chatSessionId,
    displayContent: input.prompt,
    deliveryContent: input.prompt,
    sourceTaskId: input.taskId,
    senderType: 'system',
    senderId: RESTORED_SESSION_PROMPT_SENDER_ID,
    messageClass: 'deliver',
    sourceKind: 'checkpoint_continuation',
    ttlMs: config.ttlMs,
    metadata: { restoredAgentSessionId: input.agentSessionId },
  });
  log.info('restored_session_prompt.queued', logContext);
}
