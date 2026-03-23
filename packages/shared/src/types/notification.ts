// =============================================================================
// Notifications
// =============================================================================

export const NOTIFICATION_TYPES = [
  'task_complete',
  'needs_input',
  'error',
  'progress',
  'session_ended',
  'pr_created',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_URGENCIES = ['high', 'medium', 'low'] as const;
export type NotificationUrgency = (typeof NOTIFICATION_URGENCIES)[number];

export const NOTIFICATION_CHANNELS = ['in_app'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationResponse {
  id: string;
  projectId: string | null;
  taskId: string | null;
  sessionId: string | null;
  type: NotificationType;
  urgency: NotificationUrgency;
  title: string;
  body: string | null;
  actionUrl: string | null;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
}

export interface ListNotificationsResponse {
  notifications: NotificationResponse[];
  unreadCount: number;
  nextCursor: string | null;
}

export interface NotificationPreference {
  notificationType: NotificationType | '*';
  projectId: string | null;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface NotificationPreferencesResponse {
  preferences: NotificationPreference[];
}

export interface UpdateNotificationPreferenceRequest {
  notificationType: NotificationType | '*';
  projectId?: string | null;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface CreateNotificationRequest {
  projectId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  type: NotificationType;
  urgency: NotificationUrgency;
  title: string;
  body?: string | null;
  actionUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** WebSocket message types for real-time notification delivery */
export type NotificationWsMessage =
  | { type: 'notification.new'; notification: NotificationResponse }
  | { type: 'notification.updated'; notification: NotificationResponse }
  | { type: 'notification.read'; notificationId: string }
  | { type: 'notification.dismissed'; notificationId: string }
  | { type: 'notification.all_read' }
  | { type: 'notification.unread_count'; count: number }
  | { type: 'pong' };
