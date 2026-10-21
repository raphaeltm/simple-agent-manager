import { useEffect, useRef, useState } from 'react';

import { API_URL } from '../../lib/api/client';
import { SAM_STREAM_MAX_RECONNECTS, SAM_STREAM_RECONNECT_MS } from '../../lib/poll-intervals';
import {
  applyLiveEvent,
  type LiveEvent,
  type LiveView,
  takeSseEvents,
  viewFromSnapshot,
} from './sam-live';

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
 * leave the page on polling, after one refresh. The stream closes in hidden tabs and
 * reopens on return, where its snapshot catches up.
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
    /** Applies one event; `resync` asks for a fresh snapshot after an out-of-order delta. */
    const apply = (event: LiveEvent): 'next' | 'done' | 'resync' => {
      if (event.type === 'snapshot') show(viewFromSnapshot(event, Date.now()));
      else if (current) {
        const next = applyLiveEvent(current, event, Date.now());
        if (!next) return 'resync';
        show(next);
      }
      if (event.type === 'tool' && event.activity.state !== 'running') settled.current();
      return event.type === 'done' ? 'done' : 'next';
    };
    const follow = async (): Promise<'done' | 'idle' | 'dropped'> => {
      // Each connection starts from its own snapshot; deltas before it are ignored.
      current = null;
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
          const result = apply(event);
          // Out of order: reconnect for a fresh snapshot rather than show a garbled answer.
          if (result === 'resync') {
            void reader.cancel();
            return 'dropped';
          }
          if (result === 'done') return 'done';
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
        // Done, not running here, or out of retries: history shows what happened.
        if (outcome !== 'dropped' || attempt >= SAM_STREAM_MAX_RECONNECTS) {
          settled.current();
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SAM_STREAM_RECONNECT_MS * (attempt + 1));
          abort.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        });
      }
    })();
    return () => abort.abort();
  }, [turnId, visible]);

  return { view: view?.turnId === turnId ? view : null, streaming };
}
