import { useCallback, useEffect, useMemo, useState } from 'react';

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
  enabled: boolean,
  messageIndexMap: Map<string, number>
): UseSessionTimelineResult {
  const [timelineMessages, setTimelineMessages] = useState<ChatMessageResponse[]>([]);
  const [activityEvents, setActivityEvents] = useState<ActivityEventResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const fetchTimeline = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const messagePages: ChatMessageResponse[][] = [];
      let before: number | undefined;

      for (;;) {
        if (signal.aborted) return;
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

      if (!signal.aborted) {
        setTimelineMessages(messagePages.flat());
      }
    } catch {
      // Silently handle — timeline is supplementary
    }

    try {
      if (signal.aborted) return;
      const eventsResult = await listActivityEvents(projectId, {
        sessionId,
        limit: 100,
      });
      if (!signal.aborted) {
        setActivityEvents(eventsResult.events);
      }
    } catch {
      // Silently handle — timeline is supplementary
    } finally {
      if (!signal.aborted) {
        setLoading(false);
      }
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    setTimelineMessages([]);
    setActivityEvents([]);
  }, [projectId, sessionId]);

  // Fetch server-backed timeline data when drawer opens
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchTimeline(controller.signal).catch(() => undefined);
    return () => { controller.abort(); };
  }, [enabled, fetchTimeline]);

  const messagesForTimeline = useMemo(
    () => mergeMessages(timelineMessages, (messages ?? []).filter((msg) => msg.role === 'user'), 'append'),
    [timelineMessages, messages]
  );

  const entries = useMemo(
    () => buildSessionTimeline(messagesForTimeline, activityEvents, showContext, messageIndexMap),
    [messagesForTimeline, activityEvents, showContext, messageIndexMap]
  );

  return { entries, loading, showContext, setShowContext };
}
