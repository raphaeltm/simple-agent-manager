/**
 * Custom hook for the trial SSE event stream lifecycle.
 *
 * Opens an EventSource to `/api/trial/:trialId/events`, handles reconnect
 * with exponential backoff, deduplicates replayed events, and tracks
 * connection state.
 *
 * Extracted from TryDiscovery.tsx.
 */
import type { TrialEvent } from '@simple-agent-manager/shared';
import { useEffect, useRef, useState } from 'react';

import { openTrialEventStream } from '../lib/trial-api';
import {
  TRIAL_BACKOFF_BASE_MS,
  TRIAL_BACKOFF_CAP_MS,
  TRIAL_DISCOVERY_STREAM_TIMEOUT_MS,
  TRIAL_MAX_RECONNECT_ATTEMPTS,
  TRIAL_SLOW_WARN_MS,
} from '../lib/trial-ui-config';
import { eventDedupKey } from '../lib/trial-utils';

export interface ConnectionState {
  status: 'connecting' | 'open' | 'retrying' | 'failed';
  attempt: number;
}

export interface UseTrialEventsResult {
  events: TrialEvent[];
  connection: ConnectionState;
  isSlow: boolean;
  /** Ref to the underlying EventSource — used to check if discovery is still streaming. */
  sourceRef: React.RefObject<EventSource | null>;
}

export function useTrialEvents(trialId: string | undefined): UseTrialEventsResult {
  const [events, setEvents] = useState<TrialEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
    attempt: 0,
  });
  const [isSlow, setIsSlow] = useState(false);

  // Keep refs so the SSE callback doesn't need to re-run on every event.
  const sourceRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);
  // Dedup by composite key (`type:at`). Events can replay on SSE reconnect
  // because the server may resend buffered events after the EventSource
  // re-opens; without dedup, the feed would duplicate every replayed event.
  const seenKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!trialId) return undefined;

    closedRef.current = false;
    // Reset dedup state when the trial id changes — a different trial means
    // a different event stream and previously-seen keys are no longer relevant.
    seenKeysRef.current = new Set();

    const clearRetryTimer = () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const clearSlowTimer = () => {
      if (slowTimerRef.current !== null) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
    };

    // Show "this is taking longer than usual" hint if no event arrives.
    slowTimerRef.current = setTimeout(() => {
      if (!closedRef.current) setIsSlow(true);
    }, TRIAL_SLOW_WARN_MS);

    const open = () => {
      if (closedRef.current) return;

      attemptRef.current += 1;
      setConnection({ status: 'connecting', attempt: attemptRef.current });

      const source = openTrialEventStream(trialId, {
        onOpen: () => {
          if (closedRef.current) return;
          attemptRef.current = 0;
          setConnection({ status: 'open', attempt: 0 });
        },
        onEvent: (event) => {
          if (closedRef.current) return;
          // Composite key dedup — server may replay buffered events after
          // an SSE reconnect. Drop duplicates before they reach the feed.
          const key = eventDedupKey(event);
          if (seenKeysRef.current.has(key)) return;
          seenKeysRef.current.add(key);
          // Any event clears the slow-warn — momentum has resumed.
          clearSlowTimer();
          setIsSlow(false);
          setEvents((prev) => [...prev, event]);
          // Close immediately only on hard errors. `trial.ready` is a
          // milestone (workspace provisioned) — the discovery agent keeps
          // producing knowledge + idea events afterward.
          if (event.type === 'trial.error') {
            sourceRef.current?.close();
            sourceRef.current = null;
            setConnection({ status: 'open', attempt: 0 });
          }
          // On trial.ready, start a grace timer — keep the stream open for
          // TRIAL_DISCOVERY_STREAM_TIMEOUT_MS so late-arriving discovery
          // events still reach the feed.
          if (event.type === 'trial.ready' && !discoveryTimerRef.current) {
            discoveryTimerRef.current = setTimeout(() => {
              sourceRef.current?.close();
              sourceRef.current = null;
            }, TRIAL_DISCOVERY_STREAM_TIMEOUT_MS);
          }
        },
        onError: () => {
          if (closedRef.current) return;
          sourceRef.current?.close();
          sourceRef.current = null;

          if (attemptRef.current >= TRIAL_MAX_RECONNECT_ATTEMPTS) {
            setConnection({ status: 'failed', attempt: attemptRef.current });
            return;
          }

          const delay = Math.min(
            TRIAL_BACKOFF_CAP_MS,
            TRIAL_BACKOFF_BASE_MS * 2 ** (attemptRef.current - 1),
          );
          setConnection({ status: 'retrying', attempt: attemptRef.current });
          retryTimerRef.current = setTimeout(open, delay);
        },
      });
      sourceRef.current = source;
    };

    open();

    return () => {
      closedRef.current = true;
      clearRetryTimer();
      clearSlowTimer();
      if (discoveryTimerRef.current !== null) {
        clearTimeout(discoveryTimerRef.current);
        discoveryTimerRef.current = null;
      }
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [trialId]);

  return { events, connection, isSlow, sourceRef };
}
