import type {
  ProjectEventAgentVisibility,
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

function isPersonalCredentialEvent(event: ProjectEventRecord): boolean {
  if (event.source !== CREDENTIAL_LIMIT_EVENT_SOURCE) return false;
  const credentialSource = metadataText(event.metadata, 'credentialSource');
  const visibilityScope = metadataText(event.metadata, 'visibilityScope');
  return credentialSource === 'user' || visibilityScope === 'user';
}

function targetMatchesCredentialEvent(
  event: ProjectEventRecord,
  target: ProjectEventAgentVisibility['target']
): boolean {
  const agentSessionId = metadataText(event.metadata, 'agentSessionId');
  const chatSessionId = metadataText(event.metadata, 'chatSessionId');
  if (agentSessionId && target.agentId === agentSessionId) return true;
  if (chatSessionId && target.sessionId === chatSessionId) return true;
  return !agentSessionId && !chatSessionId;
}

export function subscriptionCanMatchProjectEvent(
  subscription: ProjectEventSubscriptionRecord,
  event: ProjectEventRecord
): boolean {
  if (!isPersonalCredentialEvent(event)) return true;
  return targetMatchesCredentialEvent(event, subscription.deliveryPreference.target ?? {});
}

export function agentCanSeeProjectEvent(
  visibility: ProjectEventAgentVisibility,
  event: ProjectEventRecord
): boolean {
  if (!isPersonalCredentialEvent(event)) return true;
  const affectedUserId = metadataText(event.metadata, 'affectedUserId') ?? metadataText(event.metadata, 'userId');
  if (affectedUserId && visibility.userId !== affectedUserId) return false;
  return targetMatchesCredentialEvent(event, visibility.target);
}
