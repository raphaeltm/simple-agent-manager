import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityFeed } from '../components/ActivityFeed';
import { listActivityEvents } from '../lib/api';
import type { ActivityEventResponse } from '../lib/api';
import { useProjectContext } from './ProjectContext';

export function ProjectActivity() {
  const { projectId } = useProjectContext();

  const [activityEvents, setActivityEvents] = useState<ActivityEventResponse[]>([]);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityLoading, setActivityLoading] = useState(true);
  const eventsRef = useRef(activityEvents);
  eventsRef.current = activityEvents;

  const loadActivityEvents = useCallback(async (loadMore = false) => {
    try {
      setActivityLoading(true);
      const lastEvent = loadMore ? eventsRef.current[eventsRef.current.length - 1] : undefined;
      const before = lastEvent?.createdAt;
      const result = await listActivityEvents(projectId, { limit: 20, before });
      if (loadMore) {
        setActivityEvents((prev) => [...prev, ...result.events]);
      } else {
        setActivityEvents(result.events);
      }
      setActivityHasMore(result.hasMore);
    } catch {
      // Best-effort
    } finally {
      setActivityLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadActivityEvents(); }, [loadActivityEvents]);

  return (
    <section
      style={{
        border: '1px solid var(--sam-color-border-default)',
        borderRadius: 'var(--sam-radius-md)',
        background: 'var(--sam-color-bg-surface)',
        overflow: 'hidden',
      }}
    >
      <ActivityFeed
        events={activityEvents}
        hasMore={activityHasMore}
        onLoadMore={() => void loadActivityEvents(true)}
        loading={activityLoading}
      />
    </section>
  );
}
