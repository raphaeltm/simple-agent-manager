import type {
  ListNotificationsResponse,
  NotificationPreferencesResponse,
  NotificationType,
  UpdateNotificationPreferenceRequest,
} from '@simple-agent-manager/shared';

import { API_URL, request } from './client';

export async function listNotifications(opts?: {
  cursor?: string;
  limit?: number;
  filter?: 'all' | 'unread';
  type?: NotificationType;
  projectId?: string;
}): Promise<ListNotificationsResponse> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set('cursor', opts.cursor);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.filter) params.set('filter', opts.filter);
  if (opts?.type) params.set('type', opts.type);
  if (opts?.projectId) params.set('projectId', opts.projectId);
  const qs = params.toString();
  return request<ListNotificationsResponse>(`/api/notifications${qs ? `?${qs}` : ''}`);
}

export async function getNotificationUnreadCount(): Promise<{ count: number }> {
  return request<{ count: number }>('/api/notifications/unread-count');
}

export async function markNotificationRead(id: string): Promise<void> {
  await request('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST' });
}

export async function markAllNotificationsRead(): Promise<void> {
  await request('/api/notifications/read-all', { method: 'POST' });
}

export async function dismissNotification(id: string): Promise<void> {
  await request('/api/notifications/' + encodeURIComponent(id) + '/dismiss', { method: 'POST' });
}

export async function getNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  return request<NotificationPreferencesResponse>('/api/notifications/preferences');
}

export async function updateNotificationPreference(
  pref: UpdateNotificationPreferenceRequest
): Promise<void> {
  await request('/api/notifications/preferences', {
    method: 'PUT',
    body: JSON.stringify(pref),
  });
}

/**
 * Build the WebSocket URL for real-time notification delivery.
 * Auth cookie is sent automatically via the WebSocket connection.
 */
export function getNotificationWsUrl(): string {
  const base = API_URL.replace(/^http/, 'ws');
  return `${base}/api/notifications/ws`;
}
