import type { NotificationResponse } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { listNotifications } from '../../lib/api/notifications';
import type { ActivityEventResponse, ChatMessageResponse } from '../../lib/api/sessions';
import { listActivityEvents, listChatMessages } from '../../lib/api/sessions';
import { mergeMessages } from '../../lib/merge-messages';
import { buildSessionTimeline } from './buildSessionTimeline';
import type { TimelineEntry } from './timeline-types';

interface UseSessionTimelineResult {
  entries: TimelineEntry[];
  loading: boolean;
  showContext: boolean;
  setShowContext: (v: boolean) => void;
}

export function useSessionTimeline(
  projectId: string,
  sessionId: string,
  messages: ChatMessageResponse[],
  enabled: boolean
): UseSessionTimelineResult {
  const [timelineMessages, setTimelineMessages] = useState<ChatMessageResponse[]>([]);
  const [activityEvents, setActivityEvents] = useState<ActivityEventResponse[]>([]);
  const [progressNotifications, setProgressNotifications] = useState<NotificationResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const fetchTimeline = useCallback(async () => {
    setLoading(true);
    try {
      const messagePages: ChatMessageResponse[][] = [];
      let before: number | undefined;

      for (;;) {
        const result = await listChatMessages(projectId, sessionId, {
          before,
          roles: ['user'],
          compact: true,
        });

        if (result.messages.length === 0) {
          break;
        }

        messagePages.unshift(result.messages);
        before = result.messages[0]?.createdAt;

        if (!result.hasMore) break;
      }

      setTimelineMessages(messagePages.flat());
    } catch {
      // Silently handle — timeline is supplementary
    }

    try {
      const notificationPages: NotificationResponse[][] = [];
      let cursor: string | undefined;

      for (;;) {
        const notificationsResult = await listNotifications({
          projectId,
          sessionId,
          type: 'progress',
          cursor,
        });
        notificationPages.push(notificationsResult.notifications);

        if (!notificationsResult.nextCursor || notificationsResult.notifications.length === 0) {
          break;
        }
        cursor = notificationsResult.nextCursor;
      }

      setProgressNotifications(notificationPages.flat());
    } catch {
      // Silently handle — timeline is supplementary
    }

    try {
      const eventsResult = await listActivityEvents(projectId, {
        sessionId,
        limit: 100,
      });
      setActivityEvents(eventsResult.events);
    } catch {
      // Silently handle — timeline is supplementary
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    setTimelineMessages([]);
    setActivityEvents([]);
    setProgressNotifications([]);
  }, [projectId, sessionId]);

  // Fetch server-backed timeline data when drawer opens
  useEffect(() => {
    if (!enabled) return;
    fetchTimeline().catch(() => undefined);
  }, [enabled, fetchTimeline]);

  const messagesForTimeline = useMemo(
    () => mergeMessages(timelineMessages, (messages ?? []).filter((msg) => msg.role === 'user'), 'append'),
    [timelineMessages, messages]
  );

  const entries = useMemo(
    () => buildSessionTimeline(messagesForTimeline, activityEvents, progressNotifications, showContext),
    [messagesForTimeline, activityEvents, progressNotifications, showContext]
  );

  return { entries, loading, showContext, setShowContext };
}
