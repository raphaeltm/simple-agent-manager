/**
 * Live view of the running SAM turn, as served by `GET /api/sam/turns/:id/stream`
 * (server: `apps/api/src/durable-objects/sam-session/operator/live.ts`). Polled history
 * carries the same snapshot on the running turn, so a page without a stream still moves.
 */
export type LivePhase = 'starting' | 'thinking' | 'working' | 'writing';
export type LiveToolState = 'running' | 'completed' | 'failed' | 'needs_approval' | 'uncertain';

export interface LiveActivity {
  id: string;
  operation: string;
  state: LiveToolState;
  target?: Record<string, string | number | boolean>;
  count?: number;
  more?: boolean;
}

export interface LiveSnapshot {
  turnId: string;
  phase: LivePhase;
  elapsedMs: number;
  text: string;
  thinking: string | null;
  activity: LiveActivity[];
}

export type LiveEvent =
  | ({ type: 'snapshot' } & LiveSnapshot)
  | { type: 'phase'; phase: LivePhase }
  | { type: 'text'; at: number; text: string }
  | { type: 'draft-reset' }
  | { type: 'thinking'; text: string | null }
  | { type: 'tool'; activity: LiveActivity }
  | { type: 'done'; state: string };

/** Client-side view: the snapshot plus a local start time, so elapsed time ignores clock skew. */
export interface LiveView {
  turnId: string;
  phase: LivePhase;
  text: string;
  thinking: string | null;
  activity: LiveActivity[];
  startedAt: number;
}

export function viewFromSnapshot(snapshot: LiveSnapshot, receivedAt: number): LiveView {
  return {
    turnId: snapshot.turnId,
    phase: snapshot.phase,
    text: snapshot.text,
    thinking: snapshot.thinking,
    activity: snapshot.activity,
    startedAt: receivedAt - snapshot.elapsedMs,
  };
}

/**
 * Apply one event. Returns `null` when the event cannot be applied in order (a text
 * delta that does not start where the view ends); the caller resynchronises from a
 * fresh snapshot instead of showing a garbled answer.
 */
export function applyLiveEvent(view: LiveView, event: LiveEvent, now: number): LiveView | null {
  switch (event.type) {
    case 'snapshot':
      return viewFromSnapshot(event, now);
    case 'phase':
      return { ...view, phase: event.phase };
    case 'text':
      if (event.at > view.text.length) return null;
      return { ...view, text: view.text.slice(0, event.at) + event.text };
    case 'draft-reset':
      return { ...view, text: '' };
    case 'thinking':
      return { ...view, thinking: event.text };
    case 'tool': {
      const exists = view.activity.some((item) => item.id === event.activity.id);
      return {
        ...view,
        activity: exists
          ? view.activity.map((item) => (item.id === event.activity.id ? event.activity : item))
          : [...view.activity, event.activity],
      };
    }
    case 'done':
      return view;
  }
}

/** Split complete SSE frames off a buffer; comment frames (heartbeats) are skipped. */
export function takeSseEvents(buffer: string): { events: LiveEvent[]; rest: string } {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: LiveEvent[] = [];
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n');
    if (!data) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && 'type' in parsed)
        events.push(parsed as LiveEvent);
    } catch {
      // A malformed frame is skipped; the next snapshot or poll resynchronises.
    }
  }
  return { events, rest };
}
