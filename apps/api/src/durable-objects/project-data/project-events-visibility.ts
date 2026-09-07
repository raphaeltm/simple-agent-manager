import type {
  ProjectEventAgentVisibility,
  ProjectEventAudience,
  ProjectEventJsonValue,
  ProjectEventRecord,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';
import { CREDENTIAL_LIMIT_EVENT_SOURCE } from '@simple-agent-manager/shared';

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

export function subscriptionCanMatchProjectEvent(
  subscription: ProjectEventSubscriptionRecord,
  event: ProjectEventRecord
): boolean {
  if (!isCredentialEvent(event)) return true;
  const audience = authorizedCredentialAudience(event);
  if (!audience) return false;
  if (audience.scope === 'project') return true;
  if (!subscriptionOwnerMatchesCredentialAudience(subscription, audience)) return false;
  return targetMatchesCredentialEvent(event, subscription.deliveryPreference.target ?? {});
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
