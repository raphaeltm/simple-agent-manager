/**
 * Shared chat session state helpers used by ProjectChat, Chats page, and other components.
 */
import { classifyFailure } from '@simple-agent-manager/shared';
import {
  AlertCircle,
  CheckCircle2,
  CirclePause,
  HelpCircle,
  Loader2,
  Moon,
  XCircle,
} from 'lucide-react';

import type { ChatSessionListItem, ChatSessionResponse } from './api';

/** Sessions with no activity in this window are considered stale and hidden by default (ms). */
const DEFAULT_STALE_SESSION_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours
export const STALE_SESSION_THRESHOLD_MS = parseInt(
  import.meta.env.VITE_STALE_SESSION_THRESHOLD_MS || String(DEFAULT_STALE_SESSION_THRESHOLD_MS)
);

export type SessionState = 'active' | 'idle' | 'sleeping' | 'terminated';

/** Whether the associated task (if any) has reached a terminal state. */
function isTaskTerminal(session: ChatSessionListItem): boolean {
  const s = (session as ChatSessionResponse).task?.status;
  return s === 'failed' || s === 'completed' || s === 'cancelled';
}

export function getSessionState(session: ChatSessionListItem): SessionState {
  if (session.status === 'stopped' || session.status === 'failed') return 'terminated';
  // Sleeping remains resumable even when its backing conversation task has
  // completed. The same-chat follow-up is the wake gesture.
  if (session.status === 'sleeping') return 'sleeping';
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
  sleeping: 'var(--sam-color-info, #3b82f6)',
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
  sleeping: 'var(--sam-color-info-tint, rgba(59, 130, 246, 0.12))',
  terminated: 'var(--sam-color-bg-surface-hover)',
};

export const STATE_LABELS: Record<SessionState, string> = {
  active: 'Active',
  idle: 'Idle',
  sleeping: 'Sleeping',
  terminated: 'Stopped',
};

/**
 * Whether a session should appear on the Chats page.
 * Excludes stopped/terminated sessions so that the "active chats" framing is accurate.
 * Callers should also apply isStaleSession() to remove old inactive sessions.
 */
export function isActiveSession(session: ChatSessionListItem): boolean {
  if (session.status === 'stopped' || session.status === 'failed') return false;
  if (session.status === 'sleeping') return true;
  if (isTaskTerminal(session)) return false;
  return true;
}

/** Returns the most relevant activity timestamp for a session. */
export function getLastActivity(session: ChatSessionListItem): number {
  return session.lastMessageAt ?? session.startedAt;
}

/** Whether a session is "stale" — no activity within the threshold window. */
export function isStaleSession(session: ChatSessionListItem): boolean {
  // The server terminalizes sleeping sessions at snapshot expiry. Until then,
  // keep them discoverable so users can exercise the same-chat wake gesture.
  if (session.status === 'sleeping') return false;
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
  | 'sleeping'
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

  // Sleeping is a resumable lifecycle state, even when the task that produced
  // the latest turn is complete.
  if (session.status === 'sleeping') return 'sleeping';

  // 2. Task terminal states
  const taskStatus = session.task?.status;
  if (taskStatus === 'failed') {
    const classification = classifyFailure(
      session.task?.errorMessage ?? '',
      session.task?.executionStep ?? undefined
    );
    return classification.diagnosable ? 'failed' : 'stopped';
  }
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

/**
 * Attention state -> icon + color + label mapping (uses design tokens).
 *
 * Single source of truth consumed by `SessionItem` (full session card) and the
 * Focus Mode session strip (`FocusStrip`). The `active` icon (`Loader2`) is the
 * only one intended to spin — callers add `animate-spin` when the state is
 * `active`.
 */
export const ATTENTION_ICON: Record<
  AttentionState,
  { icon: typeof HelpCircle; color: string; label: string }
> = {
  needs_input: {
    icon: HelpCircle,
    color: 'var(--sam-color-warning, #f59e0b)',
    label: 'Needs input',
  },
  error: { icon: AlertCircle, color: 'var(--sam-color-danger, #ef4444)', label: 'Error' },
  active: { icon: Loader2, color: 'var(--sam-color-success)', label: 'Running' },
  idle: { icon: CirclePause, color: 'var(--sam-color-warning, #f59e0b)', label: 'Idle' },
  sleeping: { icon: Moon, color: 'var(--sam-color-info, #3b82f6)', label: 'Sleeping' },
  completed: { icon: CheckCircle2, color: 'var(--sam-color-fg-muted)', label: 'Completed' },
  failed: { icon: XCircle, color: 'var(--sam-color-danger, #ef4444)', label: 'Failed' },
  stopped: { icon: CirclePause, color: 'var(--sam-color-fg-muted)', label: 'Stopped' },
};

export { formatRelativeTime } from './time-utils';
