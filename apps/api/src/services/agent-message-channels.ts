/**
 * Ordinary agent messages over SAM-managed `agent-dm.*` pair channels.
 *
 * Disabled by default (`AGENT_MESSAGE_CHANNELS_ENABLED`). The transport is only
 * effective while the canonical event wake path and durable prompt delivery are
 * both enabled; without them a recipient would never be notified, so the
 * messaging tools keep their legacy path instead of accepting a message nobody
 * will hear about.
 */
import {
  type AgentChannelMessageClass,
  type AgentChannelMessageParticipant,
  DEFAULT_AGENT_MESSAGE_CHANNELS_ENABLED,
  type ProjectEventChannelActor,
  type ProjectEventJsonValue,
  type SendAgentChannelMessageResult,
} from '@simple-agent-manager/shared';

import { resolveDurableExecutionConfig } from '../durable-objects/project-data/durable-execution-config';
import { isProjectEventWakeEnabled } from '../durable-objects/project-data/project-events-wake-config';
import type { Env } from '../env';
import * as projectData from './project-data';
import { isSessionRecoverySourceTaskGuardValid } from './session-recovery-authority';

export type AgentMessageChannelsConfig =
  | { enabled: true }
  | {
      enabled: false;
      reason: 'flag_off' | 'project_event_wake_disabled' | 'durable_prompt_delivery_disabled';
    };

export function resolveAgentMessageChannelsConfig(env: Env): AgentMessageChannelsConfig {
  const flag = env.AGENT_MESSAGE_CHANNELS_ENABLED?.trim();
  // Only an explicit "true" enables the channel transport; any other value keeps it off.
  const requested = flag ? flag === 'true' : DEFAULT_AGENT_MESSAGE_CHANNELS_ENABLED;
  if (!requested) return { enabled: false, reason: 'flag_off' };
  if (!isProjectEventWakeEnabled(env)) {
    return { enabled: false, reason: 'project_event_wake_disabled' };
  }
  if (!resolveDurableExecutionConfig(env).deliveryEnabled) {
    return { enabled: false, reason: 'durable_prompt_delivery_disabled' };
  }
  return { enabled: true };
}

export interface SendAgentMessageOverChannelInput {
  projectId: string;
  actor: ProjectEventChannelActor;
  senderSourceTaskId: string;
  recipient: AgentChannelMessageParticipant;
  message: string;
  messageClass: AgentChannelMessageClass;
  idempotencyKey: string;
  senderMetadata: Record<string, ProjectEventJsonValue> | null;
}

export async function sendAgentMessageOverChannel(
  env: Env,
  input: SendAgentMessageOverChannelInput
): Promise<SendAgentChannelMessageResult> {
  // The wake path re-checks this exact guard before every delivery. Checking it
  // first keeps "accepted" truthful: SAM never records a message it already
  // knows it cannot announce. Sender authority is enforced inside ProjectData.
  const recipientCanWake = await isSessionRecoverySourceTaskGuardValid(env.DATABASE, {
    requireSourceProjectMember: true,
    taskId: input.recipient.sourceTaskId,
    projectId: input.projectId,
    chatSessionId: input.recipient.chatSessionId,
  });
  if (!recipientCanWake) throw new projectData.AgentMessageRecipientUnavailableError();
  return projectData.sendAgentChannelMessage(env, input.projectId, {
    actor: input.actor,
    senderSourceTaskId: input.senderSourceTaskId,
    recipient: input.recipient,
    message: input.message,
    messageClass: input.messageClass,
    idempotencyKey: input.idempotencyKey,
    senderMetadata: input.senderMetadata,
  });
}
