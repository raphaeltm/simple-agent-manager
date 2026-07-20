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

export type SessionEvent =
  | { type: 'session.created'; payload: SessionCreatedPayload }
  | { type: 'session.updated'; payload: SessionUpdatedPayload }
  | { type: 'session.stopped'; payload: SessionStoppedPayload }
  | { type: 'session.failed'; payload: SessionFailedPayload }
  | { type: 'session.agent_completed'; payload: SessionAgentCompletedPayload }
  | { type: 'session.activity'; payload: SessionActivityPayload };

// ---------------------------------------------------------------------------
// Convert raw WebSocket payload to typed event
// ---------------------------------------------------------------------------

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
      return {
        type: 'session.updated',
        payload: {
          sessionId: String(p.sessionId ?? ''),
          ...(p.topic != null ? { topic: String(p.topic) } : {}),
          ...(p.taskId != null ? { taskId: String(p.taskId) } : {}),
          ...(p.workspaceId != null ? { workspaceId: String(p.workspaceId) } : {}),
        },
      };
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
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pure reducer — applies a single delta to a sessions array
// ---------------------------------------------------------------------------

export function applySessionEvent(
  sessions: ChatSessionListItem[],
  event: SessionEvent,
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
      const { sessionId } = event.payload;
      return patchSession(sessions, sessionId, (s) => ({
        ...s,
        lastMessageAt: Date.now(),
      }));
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
  events: SessionEvent[],
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
  updater: (s: ChatSessionListItem) => ChatSessionListItem,
): ChatSessionListItem[] {
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return sessions;
  const existing = sessions[idx]!;
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
  10,
);

export function useSessionReducer() {
  const [sessions, setSessions] = useState<ChatSessionListItem[]>([]);
  const batchRef = useRef<SessionEvent[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushBatch = useCallback(() => {
    batchTimerRef.current = null;
    const events = batchRef.current;
    if (events.length === 0) return;
    batchRef.current = [];
    setSessions((prev) => applySessionEvents(prev, events));
  }, []);

  const dispatchEvent = useCallback((event: SessionEvent) => {
    batchRef.current.push(event);
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushBatch, BATCH_DELAY_MS);
    }
  }, [flushBatch]);

  const resetSessions = useCallback((next: ChatSessionListItem[]) => {
    batchRef.current = [];
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    setSessions(next);
  }, []);

  useEffect(() => {
    return () => {
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    };
  }, []);

  return { sessions, dispatchEvent, resetSessions };
}
