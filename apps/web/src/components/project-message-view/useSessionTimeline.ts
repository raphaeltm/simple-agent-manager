import { DEFAULT_CHAT_TIMELINE_MAX_PAGES, type NotificationResponse } from '@simple-agent-manager/shared';
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
    // Safety bound on both pagination loops below. They were previously `for(;;)`
    // with no page cap, so a server that keeps reporting `hasMore`/`nextCursor`
    // — or a cursor that stops advancing — would spin forever, holding the
    // drawer in its loading state and issuing unbounded requests. Same guard as
    // `loadUntil`'s in useSessionLifecycle.
    const maxPages =
      Number.parseInt(import.meta.env.VITE_CHAT_TIMELINE_MAX_PAGES || '', 10) ||
      DEFAULT_CHAT_TIMELINE_MAX_PAGES;

    try {
      const messagePages: ChatMessageResponse[][] = [];
      let before: number | undefined;
      let pages = 0;

      while (pages++ < maxPages) {
        const result = await listChatMessages(projectId, sessionId, {
          before,
          roles: ['user'],
          compact: true,
        });

        if (result.messages.length === 0) {
          break;
        }

        messagePages.unshift(result.messages);
        const nextBefore = result.messages[0]?.createdAt;
        // A cursor that fails to advance would re-request the same page forever.
        if (nextBefore === undefined || nextBefore === before) break;
        before = nextBefore;

        if (!result.hasMore) break;
      }

      setTimelineMessages(messagePages.flat());
    } catch {
      // Silently handle — timeline is supplementary
    }

    try {
      const notificationPages: NotificationResponse[][] = [];
      let cursor: string | undefined;
      let pages = 0;

      while (pages++ < maxPages) {
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
        // Same non-advancing-cursor guard as the message loop above.
        if (notificationsResult.nextCursor === cursor) break;
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
