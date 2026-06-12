import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ActivityEventResponse, ChatMessageResponse } from '../../lib/api/sessions';
import { listActivityEvents } from '../../lib/api/sessions';
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
  const [activityEvents, setActivityEvents] = useState<ActivityEventResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listActivityEvents(projectId, {
        sessionId,
        limit: 100,
      });
      setActivityEvents(result.events);
    } catch {
      // Silently handle — timeline is supplementary
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  // Fetch activity events when drawer opens
  useEffect(() => {
    if (!enabled) return;
    void fetchEvents();
  }, [enabled, fetchEvents]);

  const entries = useMemo(
    () => buildSessionTimeline(messages, activityEvents, showContext, messageIndexMap),
    [messages, activityEvents, showContext, messageIndexMap]
  );

  return { entries, loading, showContext, setShowContext };
}
