import { useEffect, useRef, useState } from 'react';

import { API_URL } from '../../lib/api/client';
import { SAM_STREAM_MAX_RECONNECTS, SAM_STREAM_RECONNECT_MS } from '../../lib/poll-intervals';
import { applyLiveEvent, type LiveView, takeSseEvents, viewFromSnapshot } from './sam-live';

export interface SamLiveTurn {
  /** Live view from the stream, or null when none is connected for this turn. */
  view: LiveView | null;
  /** The stream is connected, so polling may relax. */
  streaming: boolean;
}

const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * Follow the running turn's server-sent progress. A stream is a view, never the record:
 * `onSettled` fires when a step settles or the turn ends, so the caller refreshes the
 * canonical history. 204 (not running in the server object) and repeated failures
 * leave the page on polling. The stream closes in hidden tabs and reopens on return,
 * where its snapshot catches up.
 */
export function useSamLiveTurn(turnId: string | undefined, onSettled: () => void): SamLiveTurn {
  const [view, setView] = useState<LiveView | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [visible, setVisible] = useState(pageVisible);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    const update = () => setVisible(pageVisible());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!turnId) {
      setView(null);
      setStreaming(false);
      return;
    }
    if (!visible) {
      setStreaming(false);
      return;
    }
    const abort = new AbortController();
    let current: LiveView | null = null;
    const show = (next: LiveView | null) => {
      current = next;
      setView(next);
    };
    const follow = async (): Promise<'done' | 'idle' | 'dropped'> => {
      const response = await fetch(
        `${API_URL}/api/sam/turns/${encodeURIComponent(turnId)}/stream`,
        { credentials: 'include', signal: abort.signal, headers: { accept: 'text/event-stream' } }
      );
      if (response.status === 204) return 'idle';
      if (!response.ok || !response.body) return 'dropped';
      setStreaming(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'dropped';
        const parsed = takeSseEvents(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.type === 'snapshot') show(viewFromSnapshot(event, Date.now()));
          else if (current) {
            const next = applyLiveEvent(current, event, Date.now());
            // Out of order: reconnect for a fresh snapshot rather than show a garbled answer.
            if (!next) {
              void reader.cancel();
              return 'dropped';
            }
            show(next);
          }
          if (event.type === 'tool' && event.activity.state !== 'running') settled.current();
          if (event.type === 'done') return 'done';
        }
      }
    };
    void (async () => {
      for (let attempt = 0; !abort.signal.aborted; attempt++) {
        let outcome: Awaited<ReturnType<typeof follow>> = 'dropped';
        try {
          outcome = await follow();
        } catch {
          if (abort.signal.aborted) return;
        }
        setStreaming(false);
        if (outcome === 'done') settled.current();
        if (outcome !== 'dropped' || attempt >= SAM_STREAM_MAX_RECONNECTS) return;
        await new Promise((resolve) =>
          setTimeout(resolve, SAM_STREAM_RECONNECT_MS * (attempt + 1))
        );
      }
    })();
    return () => abort.abort();
  }, [turnId, visible]);

  return { view: view?.turnId === turnId ? view : null, streaming };
}
