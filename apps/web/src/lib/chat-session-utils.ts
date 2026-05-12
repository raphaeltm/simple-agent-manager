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

/** Whether the associated task (if any) has reached a terminal state. */
function isTaskTerminal(session: ChatSessionResponse): boolean {
  const s = session.task?.status;
  return s === 'failed' || s === 'completed' || s === 'cancelled';
}

export function getSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped' || session.status === 'failed') return 'terminated';
  // If the task reached a terminal state but the session DO wasn't updated
  // (e.g., best-effort RPC failed during deploy), treat as terminated.
  if (isTaskTerminal(session)) return 'terminated';
  if (session.isIdle || session.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

export const STATE_COLORS: Record<SessionState, string> = {
  active: 'var(--sam-color-success)',
  idle: 'var(--sam-color-warning, #f59e0b)',
  terminated: 'var(--sam-color-fg-muted)',
};

/**
 * Badge background colors for each session state.
 * References correct CSS variable names from packages/ui/src/tokens/theme.css.
 * Using --sam-color-bg-surface-hover (not --sam-color-surface-hover) for terminated.
 */
export const STATE_BADGE_BG: Record<SessionState, string> = {
  active: 'var(--sam-color-success-tint)',
  idle: 'var(--sam-color-warning-tint)',
  terminated: 'var(--sam-color-bg-surface-hover)',
};

export const STATE_LABELS: Record<SessionState, string> = {
  active: 'Active',
  idle: 'Idle',
  terminated: 'Stopped',
};

/**
 * Whether a session should appear on the Chats page.
 * Excludes stopped/terminated sessions so that the "active chats" framing is accurate.
 * Callers should also apply isStaleSession() to remove old inactive sessions.
 */
export function isActiveSession(session: ChatSessionResponse): boolean {
  if (session.status === 'stopped' || session.status === 'failed') return false;
  if (isTaskTerminal(session)) return false;
  return true;
}

/** Returns the most relevant activity timestamp for a session. */
export function getLastActivity(session: ChatSessionResponse): number {
  return session.lastMessageAt ?? session.startedAt;
}

/** Whether a session is "stale" — no activity within the threshold window. */
export function isStaleSession(session: ChatSessionResponse): boolean {
  return Date.now() - getLastActivity(session) > STALE_SESSION_THRESHOLD_MS;
}

export { formatRelativeTime } from './time-utils';
