import type {
  CancelProjectScheduleRequest,
  CreateProjectScheduleRequest,
  CreateProjectStandingWatchRequest,
  PauseProjectStandingWatchRequest,
  ProjectEventChannelHistory,
  ProjectEventChannelList,
  ProjectEventDeliveryOutcomeList,
  ProjectEventSubscriptionListResult,
  ProjectEventSubscriptionMutationResult,
  ProjectEventSubscriptionState,
  ProjectScheduleList,
  ProjectScheduleMutationResult,
  ProjectStandingWatchList,
  ProjectStandingWatchMutationResult,
  ReconcileProjectScheduleRequest,
  RescheduleProjectScheduleRequest,
  RevokeProjectStandingWatchRequest,
  UpdateProjectStandingWatchRequest,
} from '@simple-agent-manager/shared';

import { request } from './api/client';

/** One bounded page per request; cursors are opaque and always project-scoped. */
export const EVENT_PAGE_SIZE = 25;
const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
function query(cursor?: string | null, sessionId?: string) {
  const params = new URLSearchParams({ limit: String(EVENT_PAGE_SIZE) });
  if (cursor) params.set('cursor', cursor);
  if (sessionId) params.set('sessionId', sessionId);
  return params.toString();
}
const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const listEventSubscriptions = (
  projectId: string,
  sessionId?: string,
  state: ProjectEventSubscriptionState | 'any' = 'any'
) =>
  request<ProjectEventSubscriptionListResult>(
    `${base(projectId)}/event-subscriptions?${query(null, sessionId)}&state=${state}`
  );
export const cancelEventSubscription = (projectId: string, id: string, reason?: string) =>
  post<ProjectEventSubscriptionMutationResult>(
    `${base(projectId)}/event-subscriptions/${encodeURIComponent(id)}/cancel`,
    { reason }
  );
export const listEventChannels = (projectId: string, cursor?: string | null) =>
  request<ProjectEventChannelList>(`${base(projectId)}/event-channels?${query(cursor)}`);
export const getEventChannelHistory = (
  projectId: string,
  channel: string,
  cursor?: string | null
) =>
  request<ProjectEventChannelHistory>(
    `${base(projectId)}/event-channels/${encodeURIComponent(channel)}/history?${query(cursor)}`
  );
export const listSchedules = (projectId: string, cursor?: string | null, sessionId?: string) =>
  request<ProjectScheduleList>(`${base(projectId)}/schedules?${query(cursor, sessionId)}`);
export const createSchedule = (projectId: string, body: CreateProjectScheduleRequest) =>
  post<ProjectScheduleMutationResult>(`${base(projectId)}/schedules`, body);
export const rescheduleSchedule = (
  projectId: string,
  id: string,
  body: RescheduleProjectScheduleRequest
) =>
  post<ProjectScheduleMutationResult>(
    `${base(projectId)}/schedules/${encodeURIComponent(id)}/reschedule`,
    body
  );
export const cancelSchedule = (projectId: string, id: string, body: CancelProjectScheduleRequest) =>
  post<ProjectScheduleMutationResult>(
    `${base(projectId)}/schedules/${encodeURIComponent(id)}/cancel`,
    body
  );
export const reconcileSchedule = (
  projectId: string,
  id: string,
  body: ReconcileProjectScheduleRequest
) =>
  post<ProjectScheduleMutationResult>(
    `${base(projectId)}/schedules/${encodeURIComponent(id)}/reconcile`,
    body
  );
export const listStandingWatches = (
  projectId: string,
  cursor?: string | null,
  sessionId?: string
) =>
  request<ProjectStandingWatchList>(
    `${base(projectId)}/standing-watches?${query(cursor, sessionId)}`
  );
export const createStandingWatch = (projectId: string, body: CreateProjectStandingWatchRequest) =>
  post<ProjectStandingWatchMutationResult>(`${base(projectId)}/standing-watches`, body);
export const updateStandingWatch = (
  projectId: string,
  id: string,
  body: UpdateProjectStandingWatchRequest
) =>
  post<ProjectStandingWatchMutationResult>(
    `${base(projectId)}/standing-watches/${encodeURIComponent(id)}/update`,
    body
  );
export const pauseStandingWatch = (
  projectId: string,
  id: string,
  body: PauseProjectStandingWatchRequest
) =>
  post<ProjectStandingWatchMutationResult>(
    `${base(projectId)}/standing-watches/${encodeURIComponent(id)}/pause`,
    body
  );
export const revokeStandingWatch = (
  projectId: string,
  id: string,
  body: RevokeProjectStandingWatchRequest
) =>
  post<ProjectStandingWatchMutationResult>(
    `${base(projectId)}/standing-watches/${encodeURIComponent(id)}/revoke`,
    body
  );

export const listEventSubscriptionDeliveries = (projectId: string, subscriptionId: string) =>
  request<ProjectEventDeliveryOutcomeList>(
    `${base(projectId)}/event-subscriptions/${encodeURIComponent(subscriptionId)}/deliveries?${query()}`
  );
