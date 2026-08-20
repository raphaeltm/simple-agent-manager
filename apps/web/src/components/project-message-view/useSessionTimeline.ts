import { DEFAULT_CHAT_TIMELINE_MAX_PAGES } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import type { ChatMessageResponse } from '../../lib/api/sessions';
import { mergeMessages } from '../../lib/merge-messages';
import {
  timelineActivityEventsQueryOptions,
  timelineProgressNotificationsQueryOptions,
  timelineUserMessagesQueryOptions,
} from '../../lib/query-options';
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
  const queryScope = useQueryScope();
  const [showContext, setShowContext] = useState(false);
  const maxPages =
    Number.parseInt(import.meta.env.VITE_CHAT_TIMELINE_MAX_PAGES || '', 10) ||
    DEFAULT_CHAT_TIMELINE_MAX_PAGES;
  const queryEnabled = enabled && Boolean(projectId && sessionId && queryScope);

  const timelineMessagesQuery = useQuery({
    ...timelineUserMessagesQueryOptions(queryScope, projectId, sessionId, maxPages),
    enabled: queryEnabled,
  });
  const progressNotificationsQuery = useQuery({
    ...timelineProgressNotificationsQueryOptions(queryScope, projectId, sessionId, maxPages),
    enabled: queryEnabled,
  });
  const activityEventsQuery = useQuery({
    ...timelineActivityEventsQueryOptions(queryScope, projectId, sessionId, 100),
    enabled: queryEnabled,
  });

  const messagesForTimeline = useMemo(
    () =>
      mergeMessages(
        timelineMessagesQuery.data ?? [],
        (messages ?? []).filter((msg) => msg.role === 'user'),
        'append'
      ),
    [timelineMessagesQuery.data, messages]
  );

  const entries = useMemo(
    () =>
      buildSessionTimeline(
        messagesForTimeline,
        activityEventsQuery.data ?? [],
        progressNotificationsQuery.data ?? [],
        showContext
      ),
    [messagesForTimeline, activityEventsQuery.data, progressNotificationsQuery.data, showContext]
  );

  const loading =
    queryEnabled &&
    [timelineMessagesQuery, progressNotificationsQuery, activityEventsQuery].some(
      (query) => query.isPending && query.data === undefined
    );

  return { entries, loading, showContext, setShowContext };
}
