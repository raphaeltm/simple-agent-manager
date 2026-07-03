import type { NotificationResponse } from '@simple-agent-manager/shared';

import type { ActivityEventResponse, ChatMessageResponse } from '../../lib/api/sessions';
import type { TimelineEntry } from './timeline-types';

type Severity = Extract<TimelineEntry, { kind: 'system_event' }>['severity'];

const EVENT_SEVERITY: Record<string, Severity> = {
  'workspace.created': 'info',
  'workspace.stopped': 'warning',
  'workspace.restarted': 'info',
  'session.started': 'info',
  'session.stopped': 'warning',
  'task.created': 'info',
  'task.delegated': 'info',
  'task.status_changed': 'info',
};

const EVENT_TITLES: Record<string, string> = {
  'workspace.created': 'Workspace created',
  'workspace.stopped': 'Workspace stopped',
  'workspace.restarted': 'Workspace restarted',
  'session.started': 'Session started',
  'session.stopped': 'Session stopped',
  'task.created': 'Task created',
  'task.delegated': 'Task delegated',
  'task.status_changed': 'Task status changed',
};

function getTaskSeverity(payload: Record<string, unknown> | null): Severity {
  const toStatus = payload?.toStatus as string | undefined;
  if (toStatus === 'completed') return 'success';
  if (toStatus === 'failed' || toStatus === 'error') return 'error';
  if (toStatus === 'cancelled') return 'warning';
  return 'info';
}

function getTaskTitle(payload: Record<string, unknown> | null): string {
  const toStatus = payload?.toStatus as string | undefined;
  if (toStatus) return `Task ${toStatus}`;
  return 'Task status changed';
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '\u2026';
}

function getNotificationText(notification: NotificationResponse): string {
  const fullMessage = notification.metadata?.fullMessage;
  const text =
    typeof fullMessage === 'string' && fullMessage.trim()
      ? fullMessage
      : notification.body || notification.title;
  return truncateText(text.trim(), 180);
}

export function buildSessionTimeline(
  messages: ChatMessageResponse[],
  activityEvents: ActivityEventResponse[],
  progressNotifications: NotificationResponse[],
  showContext: boolean
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // Add user messages
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!text.trim()) continue;

    entries.push({
      kind: 'user_message',
      id: `msg-${msg.id}`,
      messageId: msg.id,
      text: truncateText(text.trim(), 120),
      timestamp: msg.createdAt,
    });
  }

  for (const notification of progressNotifications) {
    if (notification.type !== 'progress') continue;
    const timestamp = Date.parse(notification.createdAt);
    if (!Number.isFinite(timestamp)) continue;

    const text = getNotificationText(notification);
    if (!text) continue;

    entries.push({
      kind: 'progress_notification',
      id: `notif-${notification.id}`,
      notificationId: notification.id,
      title: notification.title,
      text,
      timestamp,
      severity: 'info',
    });
  }

  // Add activity events if context is shown
  if (showContext) {
    for (const evt of activityEvents) {
      const isTaskChange = evt.eventType === 'task.status_changed';
      entries.push({
        kind: 'system_event',
        id: `evt-${evt.id}`,
        eventType: evt.eventType,
        title: isTaskChange ? getTaskTitle(evt.payload) : (EVENT_TITLES[evt.eventType] ?? evt.eventType),
        timestamp: evt.createdAt,
        severity: isTaskChange ? getTaskSeverity(evt.payload) : (EVENT_SEVERITY[evt.eventType] ?? 'info'),
      });
    }
  }

  // Sort chronologically (oldest first)
  entries.sort((a, b) => a.timestamp - b.timestamp);

  return entries;
}
