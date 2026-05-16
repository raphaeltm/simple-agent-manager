/**
 * Shared chat session state helpers used by ProjectChat, Chats page, and other components.
 */
import type { ChatSessionListItem, ChatSessionResponse } from './api';

/** Sessions with no activity in this window are considered stale and hidden by default (ms). */
const DEFAULT_STALE_SESSION_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours
export const STALE_SESSION_THRESHOLD_MS = parseInt(
  import.meta.env.VITE_STALE_SESSION_THRESHOLD_MS ||
    String(DEFAULT_STALE_SESSION_THRESHOLD_MS),
);

export type SessionState = 'active' | 'idle' | 'terminated';

/** Whether the associated task (if any) has reached a terminal state. */
function isTaskTerminal(session: ChatSessionListItem): boolean {
  const s = (session as ChatSessionResponse).task?.status;
  return s === 'failed' || s === 'completed' || s === 'cancelled';
}

export function getSessionState(session: ChatSessionListItem): SessionState {
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
export function isActiveSession(session: ChatSessionListItem): boolean {
  if (session.status === 'stopped' || session.status === 'failed') return false;
  if (isTaskTerminal(session)) return false;
  return true;
}

/** Returns the most relevant activity timestamp for a session. */
export function getLastActivity(session: ChatSessionListItem): number {
  return session.lastMessageAt ?? session.startedAt;
}

/** Whether a session is "stale" — no activity within the threshold window. */
export function isStaleSession(session: ChatSessionListItem): boolean {
  return Date.now() - getLastActivity(session) > STALE_SESSION_THRESHOLD_MS;
}

// =============================================================================
// Session Mode
// =============================================================================

export type SessionMode = 'task' | 'conversation';

/** Whether this session is task-mode or conversation-mode. */
export function getSessionMode(session: ChatSessionListItem): SessionMode {
  const taskMode = (session as ChatSessionResponse).task?.taskMode;
  if (taskMode === 'task') return 'task';
  if (taskMode === 'conversation') return 'conversation';
  // Fallback: if there's a task association, treat as task
  return session.taskId ? 'task' : 'conversation';
}

// =============================================================================
// Attention State
// =============================================================================

/** Attention state derived from attention markers and task/session lifecycle. */
export type AttentionState =
  | 'needs_input'
  | 'error'
  | 'active'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'stopped';

/**
 * Derive the attention state for a session.
 * Precedence: attention markers > task terminal state > lifecycle state.
 */
export function getAttentionState(session: ChatSessionResponse): AttentionState {
  // 1. Durable attention markers take highest precedence
  if (session.attention?.kind === 'needs_input') return 'needs_input';

  // 2. Task terminal states
  const taskStatus = session.task?.status;
  if (taskStatus === 'failed') return 'failed';
  if (taskStatus === 'completed') return 'completed';
  if (taskStatus === 'cancelled') return 'stopped';

  // 3. Session lifecycle states
  if (session.status === 'failed') return 'error';
  if (session.status === 'stopped') return 'stopped';

  if (session.isIdle || session.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';

  return 'stopped';
}

/** Whether a session's attention state should be treated as high-priority. */
export function isHighPriorityAttention(state: AttentionState): boolean {
  return state === 'needs_input' || state === 'error';
}

export { formatRelativeTime } from './time-utils';
