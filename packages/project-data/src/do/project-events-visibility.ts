import type {
  ProjectEventAgentVisibility,
  ProjectEventAudience,
  ProjectEventJsonValue,
  ProjectEventRecord,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';
import {
  CREDENTIAL_LIMIT_EVENT_SOURCE,
  isJsonRecord,
  PROJECT_EVENT_CHANNEL_SOURCE,
  PROJECT_EVENT_CHANNEL_TYPE,
} from '@simple-agent-manager/shared';

import { isAgentMessageChannelName } from './agent-message-notice';

function metadataText(
  metadata: Record<string, ProjectEventJsonValue> | undefined,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function isCredentialEvent(event: ProjectEventRecord): boolean {
  return event.source === CREDENTIAL_LIMIT_EVENT_SOURCE;
}

function credentialMetadataScope(event: ProjectEventRecord): ProjectEventAudience['scope'] | null {
  const credentialSource = metadataText(event.metadata, 'credentialSource');
  const visibilityScope = metadataText(event.metadata, 'visibilityScope');
  if (credentialSource === 'user' || visibilityScope === 'user') return 'user';
  if (
    credentialSource === 'project' ||
    credentialSource === 'platform' ||
    visibilityScope === 'project'
  ) {
    return 'project';
  }
  return null;
}

function authorizedCredentialAudience(event: ProjectEventRecord): ProjectEventAudience | null {
  if (!isCredentialEvent(event)) return event.audience;
  const metadataScope = credentialMetadataScope(event);
  if (!metadataScope) return null;
  if (event.audience.scope !== metadataScope) return null;
  if (event.audience.projectId !== event.projectId) return null;
  if (event.audience.scope === 'user' && !event.audience.userId) return null;
  if (event.audience.scope === 'project' && event.audience.userId !== null) return null;
  return event.audience;
}

function targetMatchesCredentialEvent(
  event: ProjectEventRecord,
  target: ProjectEventAgentVisibility['target']
): boolean {
  const agentSessionId = metadataText(event.metadata, 'agentSessionId');
  const chatSessionId = metadataText(event.metadata, 'chatSessionId');
  if (!agentSessionId && !chatSessionId) return false;
  if (agentSessionId && target.agentId === agentSessionId) return true;
  if (chatSessionId && target.sessionId === chatSessionId) return true;
  return false;
}

function subscriptionOwnerMatchesCredentialAudience(
  subscription: ProjectEventSubscriptionRecord,
  audience: ProjectEventAudience
): boolean {
  if (audience.scope === 'project') return true;
  if (!audience.userId) return false;
  if (subscription.owner.type === 'human') return subscription.owner.id === audience.userId;
  if (subscription.owner.type === 'agent') {
    const targetSessionId = subscription.deliveryPreference.target?.sessionId;
    return Boolean(
      targetSessionId && subscription.owner.id === `${subscription.projectId}:${targetSessionId}`
    );
  }
  return false;
}

/**
 * An `agent-dm.*` pair channel routes only to its two participants. Without this,
 * any agent could subscribe to `sam.agent_channel` and be woken with another
 * pair's agent-message notices. Participants come from the server-derived actor
 * and recipient recorded on the event; history stays project-visible.
 */
function subscriptionTargetsAgentMessageParticipant(
  subscription: ProjectEventSubscriptionRecord,
  event: ProjectEventRecord
): boolean {
  const target = subscription.deliveryPreference.target?.sessionId;
  if (!target) return false;
  const actor = event.metadata?.actor;
  const recipient = event.metadata?.recipient;
  return (
    (isJsonRecord(actor) && actor.chatSessionId === target) ||
    (isJsonRecord(recipient) && recipient.chatSessionId === target)
  );
}

function isAgentMessageEvent(event: ProjectEventRecord): boolean {
  return (
    event.source === PROJECT_EVENT_CHANNEL_SOURCE &&
    event.subject.type === 'agent_channel' &&
    isAgentMessageChannelName(event.subject.id)
  );
}

export function subscriptionCanMatchProjectEvent(
  subscription: ProjectEventSubscriptionRecord,
  event: ProjectEventRecord
): boolean {
  if (isAgentMessageEvent(event)) {
    return subscriptionTargetsAgentMessageParticipant(subscription, event);
  }
  if (!isCredentialEvent(event)) return true;
  const audience = authorizedCredentialAudience(event);
  if (!audience) return false;
  if (audience.scope === 'project') return true;
  if (!subscriptionOwnerMatchesCredentialAudience(subscription, audience)) return false;
  return targetMatchesCredentialEvent(event, subscription.deliveryPreference.target ?? {});
}

/**
 * A channel publication never wakes its own publisher. A prompt-delivery
 * subscription whose target chat is the publishing chat gets no match at all, so
 * no wake work can be queued for the echo. Record-only subscriptions keep
 * matching: they never wake anyone, and their pull feed stays unchanged.
 * `metadata.actor` is server-derived; only the channel publish path admits the
 * reserved channel source.
 */
export function isSelfOriginatedChannelWake(
  subscription: ProjectEventSubscriptionRecord,
  event: ProjectEventRecord
): boolean {
  if (event.source !== PROJECT_EVENT_CHANNEL_SOURCE) return false;
  if (event.eventType !== PROJECT_EVENT_CHANNEL_TYPE) return false;
  if (subscription.deliveryPreference.resolved !== 'queued_for_prompt_delivery') return false;
  const actor = event.metadata?.actor;
  const publisherChat =
    isJsonRecord(actor) && typeof actor.chatSessionId === 'string' ? actor.chatSessionId : null;
  return (
    publisherChat !== null && publisherChat === subscription.deliveryPreference.target?.sessionId
  );
}

export function agentCanSeeProjectEvent(
  visibility: ProjectEventAgentVisibility,
  event: ProjectEventRecord
): boolean {
  if (!isCredentialEvent(event)) return true;
  const audience = authorizedCredentialAudience(event);
  if (!audience) return false;
  if (audience.scope === 'project') return true;
  return (
    visibility.userId === audience.userId && targetMatchesCredentialEvent(event, visibility.target)
  );
}
