/**
 * Shared chat session state helpers used by ProjectChat, Chats page, and other components.
 */
import type { ChatSessionResponse } from './api';

/** Sessions with no activity in this window are considered stale and hidden by default (ms). */
const DEFAULT_STALE_SESSION_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours
export const STALE_SESSION_THRESHOLD_MS = parseInt(
  import.meta.env.VITE_STALE_SESSION_THRESHOLD_MS ||
    String(DEFAULT_STALE_SESSION_THRESHOLD_MS),
);

export type SessionState = 'active' | 'idle' | 'terminated';

export function getSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped') return 'terminated';
  if (session.isIdle || session.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

export const STATE_COLORS: Record<SessionState, string> = {
  active: 'var(--sam-color-success)',
  idle: 'var(--sam-color-warning, #f59e0b)',
  terminated: 'var(--sam-color-fg-muted)',
};

export const STATE_LABELS: Record<SessionState, string> = {
  active: 'Active',
  idle: 'Idle',
  terminated: 'Stopped',
};

/** Returns the most relevant activity timestamp for a session. */
export function getLastActivity(session: ChatSessionResponse): number {
  return session.lastMessageAt ?? session.startedAt;
}

/** Whether a session is "stale" — no activity within the threshold window. */
export function isStaleSession(session: ChatSessionResponse): boolean {
  return Date.now() - getLastActivity(session) > STALE_SESSION_THRESHOLD_MS;
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
