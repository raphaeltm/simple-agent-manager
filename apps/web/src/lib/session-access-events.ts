/**
 * Fans `session.access.changed` out to the open chat view.
 *
 * The chat socket is off while a chat sleeps, but the project-wide socket stays connected and
 * receives every session's events, so it publishes access changes here and the open chat's
 * `useSessionAccessSync` subscribes for its own session.
 */
type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

export function publishSessionAccessChanged(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

/** Calls `listener` whenever `sessionId`'s access changes; returns the unsubscribe. */
export function subscribeSessionAccessChanged(sessionId: string, listener: Listener): () => void {
  const forSession = listeners.get(sessionId) ?? new Set<Listener>();
  forSession.add(listener);
  listeners.set(sessionId, forSession);
  return () => {
    forSession.delete(listener);
    if (forSession.size === 0 && listeners.get(sessionId) === forSession)
      listeners.delete(sessionId);
  };
}
