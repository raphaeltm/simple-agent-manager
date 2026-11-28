import { useCallback, useEffect, useRef, useState } from 'react';

import type { RawSessionEvent } from '../../hooks/useProjectWebSocket';
import type { ChatSessionListItem } from '../../lib/api';

// ---------------------------------------------------------------------------
// Session event types matching ProjectData DO broadcasts
// ---------------------------------------------------------------------------

export interface SessionCreatedPayload {
  id: string;
  workspaceId?: string | null;
  taskId?: string | null;
  createdByUserId?: string | null;
  topic?: string | null;
  status: string;
  messageCount: number;
  createdAt: number;
}

export interface SessionUpdatedPayload {
  sessionId: string;
  topic?: string;
  taskId?: string;
  workspaceId?: string;
  /** Sleep (`'sleeping'`) and wake (`'active'`) broadcasts from ProjectData. */
  status?: string;
}

export interface SessionStoppedPayload {
  sessionId: string;
}

export interface SessionFailedPayload {
  sessionId: string;
}

export interface SessionAgentCompletedPayload {
  sessionId: string;
  agentCompletedAt: number;
}

export interface SessionActivityPayload {
  sessionId: string;
  activity?: string;
  promptStartedAt?: number | null;
}

export interface AttentionCreatedPayload {
  sessionId: string;
  markerId: string;
  kind: string;
  createdAt: number;
  expiresAt: number | null;
  reason: string | null;
  options: string[];
}

export interface AttentionResolvedPayload {
  sessionId: string;
  markerId?: string;
}

export type SessionEvent =
  | { type: 'session.created'; payload: SessionCreatedPayload }
  | { type: 'session.updated'; payload: SessionUpdatedPayload }
  | { type: 'session.stopped'; payload: SessionStoppedPayload }
  | { type: 'session.failed'; payload: SessionFailedPayload }
  | { type: 'session.agent_completed'; payload: SessionAgentCompletedPayload }
  | { type: 'session.activity'; payload: SessionActivityPayload }
  | { type: 'attention.created'; payload: AttentionCreatedPayload }
  | { type: 'attention.resolved'; payload: AttentionResolvedPayload };

// ---------------------------------------------------------------------------
// Convert raw WebSocket payload to typed event
// ---------------------------------------------------------------------------

/** Only the fields present on the frame are carried, so the reducer patches nothing else. */
function sessionUpdatedPayload(p: RawSessionEvent['payload']): SessionUpdatedPayload {
  return {
    sessionId: String(p.sessionId ?? ''),
    ...(p.topic != null ? { topic: String(p.topic) } : {}),
    ...(p.taskId != null ? { taskId: String(p.taskId) } : {}),
    ...(p.workspaceId != null ? { workspaceId: String(p.workspaceId) } : {}),
    ...(typeof p.status === 'string' ? { status: p.status } : {}),
  };
}

export function rawToSessionEvent(raw: RawSessionEvent): SessionEvent | null {
  const p = raw.payload;
  switch (raw.type) {
    case 'session.created':
      return {
        type: 'session.created',
        payload: {
          id: String(p.id ?? ''),
          workspaceId: p.workspaceId as string | null | undefined,
          taskId: p.taskId as string | null | undefined,
          createdByUserId: p.createdByUserId as string | null | undefined,
          topic: p.topic as string | null | undefined,
          status: String(p.status ?? 'active'),
          messageCount: Number(p.messageCount ?? 0),
          createdAt: Number(p.createdAt ?? Date.now()),
        },
      };
    case 'session.stopped':
      return { type: 'session.stopped', payload: { sessionId: String(p.sessionId ?? '') } };
    case 'session.failed':
      return { type: 'session.failed', payload: { sessionId: String(p.sessionId ?? '') } };
    case 'session.updated':
      return { type: 'session.updated', payload: sessionUpdatedPayload(p) };
    case 'session.agent_completed':
      return {
        type: 'session.agent_completed',
        payload: {
          sessionId: String(p.sessionId ?? ''),
          agentCompletedAt: Number(p.agentCompletedAt ?? Date.now()),
        },
      };
    case 'session.activity':
      return {
        type: 'session.activity',
        payload: {
          sessionId: String(p.sessionId ?? ''),
          activity: p.activity as string | undefined,
          promptStartedAt: p.promptStartedAt as number | null | undefined,
        },
      };
    case 'attention.created':
      return {
        type: 'attention.created',
        payload: {
          sessionId: String(p.sessionId ?? ''),
          markerId: String(p.markerId ?? ''),
          kind: String(p.kind ?? ''),
          createdAt: Number(p.createdAt ?? Date.now()),
          expiresAt: p.expiresAt == null ? null : Number(p.expiresAt),
          reason: p.reason == null ? null : String(p.reason),
          options: Array.isArray(p.options)
            ? p.options.filter((option): option is string => typeof option === 'string')
            : [],
        },
      };
    case 'attention.resolved':
      return {
        type: 'attention.resolved',
        payload: {
          sessionId: String(p.sessionId ?? ''),
          ...(p.markerId == null ? {} : { markerId: String(p.markerId) }),
        },
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pure reducer — applies a single delta to a sessions array
// ---------------------------------------------------------------------------

export function applySessionEvent(
  sessions: ChatSessionListItem[],
  event: SessionEvent
): ChatSessionListItem[] {
  switch (event.type) {
    case 'session.created': {
      const p = event.payload;
      if (sessions.some((s) => s.id === p.id)) return sessions;
      const newSession: ChatSessionListItem = {
        id: p.id,
        workspaceId: p.workspaceId ?? null,
        taskId: p.taskId ?? null,
        createdByUserId: p.createdByUserId ?? null,
        topic: p.topic ?? null,
        status: p.status,
        messageCount: p.messageCount,
        startedAt: p.createdAt,
        endedAt: null,
        createdAt: p.createdAt,
      };
      return [newSession, ...sessions];
    }

    case 'session.stopped': {
      const { sessionId } = event.payload;
      return patchSession(sessions, sessionId, (s) => ({
        ...s,
        status: 'stopped',
        isTerminated: true,
        endedAt: s.endedAt ?? Date.now(),
      }));
    }

    case 'session.failed': {
      const { sessionId } = event.payload;
      return patchSession(sessions, sessionId, (s) => ({
        ...s,
        status: 'failed',
        isTerminated: true,
        endedAt: s.endedAt ?? Date.now(),
      }));
    }

    case 'session.updated': {
      const { sessionId, ...fields } = event.payload;
      return patchSession(sessions, sessionId, (s) => ({
        ...s,
        ...(fields.topic !== undefined ? { topic: fields.topic } : {}),
        ...(fields.taskId !== undefined ? { taskId: fields.taskId } : {}),
        ...(fields.workspaceId !== undefined ? { workspaceId: fields.workspaceId } : {}),
        // ProjectData broadcasts `status: 'sleeping'` on sleep and `'active'` on
        // wake. Dropping it left the sidebar (and anything gating on a list
        // item's status) up to SESSION_RECONCILE_INTERVAL_MS behind the server.
        ...(fields.status !== undefined ? { status: fields.status } : {}),
      }));
    }

    case 'session.agent_completed': {
      const { sessionId, agentCompletedAt } = event.payload;
      return patchSession(sessions, sessionId, (s) => ({
        ...s,
        agentCompletedAt,
        isIdle: true,
      }));
    }

    case 'session.activity': {
      // This event reports lifecycle state, not a persisted transcript message.
      // Even promptStartedAt can be synthesized or delivered after the message,
      // so only message data or a refreshed summary may change message recency.
      return sessions;
    }

    case 'attention.created': {
      const { sessionId, ...attention } = event.payload;
      return patchSession(sessions, sessionId, (s) => ({ ...s, attention }));
    }

    case 'attention.resolved': {
      const { sessionId, markerId } = event.payload;
      return patchSession(sessions, sessionId, (s) => {
        if (markerId && s.attention?.markerId !== markerId) return s;
        return { ...s, attention: null };
      });
    }

    default:
      return sessions;
  }
}

/**
 * Apply multiple events in sequence, producing one new array.
 */
export function applySessionEvents(
  sessions: ChatSessionListItem[],
  events: SessionEvent[]
): ChatSessionListItem[] {
  let result = sessions;
  for (const event of events) {
    result = applySessionEvent(result, event);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function patchSession(
  sessions: ChatSessionListItem[],
  sessionId: string,
  updater: (s: ChatSessionListItem) => ChatSessionListItem
): ChatSessionListItem[] {
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return sessions;
  const existing = sessions[idx];
  if (!existing) return sessions;
  const updated = updater(existing);
  if (updated === existing) return sessions;
  const next = sessions.slice();
  next[idx] = updated;
  return next;
}

// ---------------------------------------------------------------------------
// React hook: batches rapid WebSocket events into single state updates
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_BATCH_DELAY_MS = 16; // ~1 animation frame
const BATCH_DELAY_MS = parseInt(
  import.meta.env.VITE_SESSION_BATCH_DELAY_MS || String(DEFAULT_SESSION_BATCH_DELAY_MS),
  10
);

export interface SessionListSnapshot {
  sessions: ChatSessionListItem[];
  revision: number;
}

/** Fields the existing reducer actually applies; creation defaults are not live patches. */
function eventFields(event: SessionEvent): string[] {
  switch (event.type) {
    case 'session.updated':
      return Object.entries(event.payload)
        .filter(([key, value]) => key !== 'sessionId' && value !== undefined)
        .map(([key]) => key);
    case 'session.stopped':
    case 'session.failed':
      return ['status', 'isTerminated', 'endedAt'];
    case 'session.agent_completed':
      return ['agentCompletedAt', 'isIdle'];
    case 'attention.created':
    case 'attention.resolved':
      return ['attention'];
    default:
      return [];
  }
}

export function useSessionReducer() {
  const [sessions, setSessions] = useState<ChatSessionListItem[]>([]);
  const sessionsRef = useRef(sessions);
  const revision = useRef(0);
  // Weak row keys keep only fixed per-field revisions for current row objects, never events.
  const fieldRevisions = useRef(new WeakMap<ChatSessionListItem, ReadonlyMap<string, number>>());
  const batchRef = useRef<SessionEvent[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyTrackedEvents = useCallback(
    (current: ChatSessionListItem[], events: SessionEvent[]) => {
      for (const event of events) {
        const id = event.type === 'session.created' ? event.payload.id : event.payload.sessionId;
        const previous = current.find((session) => session.id === id);
        const next = applySessionEvent(current, event);
        const changed = next.find((session) => session.id === id);
        if (changed && changed !== previous) {
          const fields = new Map(previous ? fieldRevisions.current.get(previous) : undefined);
          const stamp = ++revision.current;
          for (const field of eventFields(event)) fields.set(field, stamp);
          fieldRevisions.current.set(changed, fields);
        }
        current = next;
      }
      return current;
    },
    []
  );

  const flushBatch = useCallback(() => {
    batchTimerRef.current = null;
    const events = batchRef.current;
    if (events.length === 0) return;
    batchRef.current = [];
    sessionsRef.current = applyTrackedEvents(sessionsRef.current, events);
    setSessions(sessionsRef.current);
  }, [applyTrackedEvents]);

  const dispatchEvent = useCallback(
    (event: SessionEvent) => {
      batchRef.current.push(event);
      if (!batchTimerRef.current) batchTimerRef.current = setTimeout(flushBatch, BATCH_DELAY_MS);
    },
    [flushBatch]
  );

  const captureSnapshot = useCallback((): SessionListSnapshot => {
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    flushBatch();
    return { sessions: sessionsRef.current, revision: revision.current };
  }, [flushBatch]);

  const resetSessions = useCallback(
    (next: ChatSessionListItem[], before?: SessionListSnapshot) => {
      const pending = batchRef.current;
      batchRef.current = [];
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
      if (before) {
        const baseline = new Set(before.sessions.map((session) => session.id));
        const current = new Map(sessionsRef.current.map((session) => [session.id, session]));
        const received = new Set(next.map((session) => session.id));
        next = next.map((session) => {
          const live = current.get(session.id);
          if (!live) return session;
          const fields = fieldRevisions.current.get(live);
          const changes = Object.fromEntries(
            Object.entries(live).filter(([key]) => (fields?.get(key) ?? 0) > before.revision)
          );
          const merged = { ...session, ...changes };
          if (fields) fieldRevisions.current.set(merged, fields);
          return merged;
        });
        // Newly created rows may not exist in the request's snapshot; server removals stay removed.
        next = [
          ...next,
          ...[...current.values()].filter(
            (session) => !baseline.has(session.id) && !received.has(session.id)
          ),
        ];
        next = applyTrackedEvents(next, pending);
      }
      sessionsRef.current = next;
      setSessions(next);
    },
    [applyTrackedEvents]
  );

  useEffect(() => {
    return () => {
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    };
  }, []);

  return { sessions, dispatchEvent, resetSessions, captureSnapshot };
}
