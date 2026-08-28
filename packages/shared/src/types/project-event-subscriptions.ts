import type {
  ProjectEventDeliveryPreference,
  ProjectEventExpireSubscriptionsResult,
  ProjectEventFilterV1,
  ProjectEventRequestedDeliveryMode,
  ProjectEventSubscriptionListResult,
  ProjectEventSubscriptionMutationResult,
  ProjectEventSubscriptionOwner,
  ProjectEventSubscriptionRecord,
  ProjectEventSubscriptionState,
} from './project-events';

export const PROJECT_EVENT_SUBSCRIPTION_CALLER_KINDS = ['agent', 'platform'] as const;
export type ProjectEventSubscriptionCallerKind =
  (typeof PROJECT_EVENT_SUBSCRIPTION_CALLER_KINDS)[number];

export type ProjectEventSubscriptionAgentCaller = {
  kind: 'agent';
  projectId: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  chatSessionId?: string | null;
  agentSessionId?: string | null;
  ownerName?: string | null;
  mcpTokenCreatedAt?: string | null;
};

export type ProjectEventSubscriptionPlatformPermissions = {
  manageAgentSubscriptions?: boolean;
  managePolicySubscriptions?: boolean;
  manageStandingWatchSubscriptions?: boolean;
  manageSystemSubscriptions?: boolean;
  readAllSubscriptions?: boolean;
  cancelAnySubscription?: boolean;
  expireSubscriptions?: boolean;
};

export type ProjectEventSubscriptionPlatformCaller = {
  kind: 'platform';
  projectId: string;
  actorId: string;
  actorName?: string | null;
  permissions?: ProjectEventSubscriptionPlatformPermissions;
};

export type ProjectEventSubscriptionCaller =
  | ProjectEventSubscriptionAgentCaller
  | ProjectEventSubscriptionPlatformCaller;

export const PROJECT_EVENT_SUBSCRIPTION_OWNER_SCOPES = ['caller', 'specific', 'all'] as const;
export type ProjectEventSubscriptionOwnerScope =
  (typeof PROJECT_EVENT_SUBSCRIPTION_OWNER_SCOPES)[number];

export type ProjectEventSubscriptionCreateRequest = {
  owner?: ProjectEventSubscriptionOwner | null;
  idempotencyKey: string;
  filter: ProjectEventFilterV1;
  requestedDelivery: ProjectEventRequestedDeliveryMode;
  target?: ProjectEventDeliveryPreference['target'] | null;
  reason?: string | null;
  expiresAt?: number | null;
};

export type ProjectEventSubscriptionCreateResponse = ProjectEventSubscriptionMutationResult & {
  callerKind: ProjectEventSubscriptionCallerKind;
};

export type ProjectEventSubscriptionListRequest = {
  state?: ProjectEventSubscriptionState | 'any' | null;
  ownerScope?: ProjectEventSubscriptionOwnerScope | null;
  owner?: ProjectEventSubscriptionOwner | null;
  limit?: number | null;
};

export type ProjectEventSubscriptionListResponse = ProjectEventSubscriptionListResult & {
  ownerScope: ProjectEventSubscriptionOwnerScope;
};

export type ProjectEventSubscriptionGetRequest = {
  subscriptionId: string;
  ownerScope?: ProjectEventSubscriptionOwnerScope | null;
  owner?: ProjectEventSubscriptionOwner | null;
  required?: boolean;
};

export type ProjectEventSubscriptionGetResponse = {
  subscription: ProjectEventSubscriptionRecord | null;
  required: boolean;
};

export type ProjectEventSubscriptionCancelRequest = {
  subscriptionId: string;
  ownerScope?: ProjectEventSubscriptionOwnerScope | null;
  owner?: ProjectEventSubscriptionOwner | null;
  required?: boolean;
  reason?: string | null;
};

export type ProjectEventSubscriptionCancelResponse = {
  subscription: ProjectEventSubscriptionRecord | null;
  idempotent: boolean;
  changed: boolean;
  required: boolean;
};

export type ProjectEventSubscriptionExpireRequest = {
  now?: number;
  limit?: number | null;
};

export type ProjectEventSubscriptionExpireResponse = ProjectEventExpireSubscriptionsResult & {
  callerKind: ProjectEventSubscriptionCallerKind;
};
