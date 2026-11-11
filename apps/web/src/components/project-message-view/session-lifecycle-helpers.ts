import { type Dispatch, type SetStateAction, useCallback, useRef } from 'react';

import type { SessionUpdatedFields } from '../../hooks/useChatWebSocket';
import type {
  ChatSessionDetailResponse,
  ChatSessionResponse,
  SessionStateSnapshot,
} from '../../lib/api';
import { fetchNewestPage } from '../../lib/message-paging';

export type FilePanelState = {
  mode: 'browse' | 'view' | 'diff' | 'git-status';
  path?: string;
  line?: number | null;
} | null;

export function parsePlanContent(content: string): SessionStateSnapshot['currentPlan'] | null {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hashPlanContent(plan: SessionStateSnapshot['currentPlan']): string {
  if (!plan) return 'none';
  const serialized = JSON.stringify(plan);
  let hash = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    hash = ((hash << 5) - hash + serialized.charCodeAt(i)) | 0;
  }
  return `${plan.length}:${hash.toString(36)}`;
}

export function getPlanFingerprint(state: SessionStateSnapshot | null | undefined): string {
  if (!state) return 'no-state';
  return state.planUpdatedAt
    ? `updated:${state.planUpdatedAt}`
    : `content:${hashPlanContent(state.currentPlan)}`;
}

/**
 * Applies a pushed `session.updated` to the open session. The push names only what it
 * carries, but the DO's `wakeSession` (`durable-objects/project-data/sessions.ts`) also
 * clears `agent_completed_at` when it makes a session active, so a woken chat does not
 * keep the previous turn's completion and read as idle mid-turn.
 */
export function applyPushedSessionUpdate(
  prev: ChatSessionResponse | null,
  updates: SessionUpdatedFields
): ChatSessionResponse | null {
  if (!prev) return prev;
  const next = { ...prev, ...updates };
  if (updates.status === 'active' && prev.status !== 'active') {
    next.agentCompletedAt = null;
    next.isIdle = false;
  }
  return next;
}

type MergeRecentWindow = (
  recent: ChatSessionDetailResponse,
  signal?: AbortSignal,
  isCurrent?: () => boolean
) => Promise<void>;

/**
 * A status push carries only the status. Reads the newest window, as the fallback poll
 * would, so the rest of the session and its state snapshot catch up: a connected active
 * chat does not poll, so nothing else would refresh them.
 */
function reconcileAfterStatusPush(
  projectId: string,
  sessionId: string,
  mergeRecentWindow: MergeRecentWindow,
  isCurrent: () => boolean
): void {
  fetchNewestPage(projectId, sessionId)
    .then((recent) =>
      recent.session.id === sessionId ? mergeRecentWindow(recent, undefined, isCurrent) : undefined
    )
    .catch((err: unknown) => {
      // Best effort: the pushed status is already applied; the next push, reconnect or
      // poll reconciles the rest.
      console.warn('Session reconcile after a status push failed', err);
    });
}

/**
 * Handles `session.updated` pushes for the open chat. A status push is applied at once
 * (`applyPushedSessionUpdate`) and followed by a reconcile read, fenced so a read
 * overtaken by a later push or a stop cannot roll the session back. `invalidateStatus`
 * supersedes in-flight reads without starting one (the stop handler calls it).
 */
export function useSessionStatusPush(
  projectId: string,
  sessionId: string,
  mergeRecentWindow: MergeRecentWindow,
  setSession: Dispatch<SetStateAction<ChatSessionResponse | null>>
): { onSessionUpdated: (updates: SessionUpdatedFields) => void; invalidateStatus: () => void } {
  const generation = useRef(0);
  const invalidateStatus = useCallback(() => {
    generation.current += 1;
  }, []);
  const onSessionUpdated = useCallback(
    (updates: SessionUpdatedFields) => {
      setSession((prev) => applyPushedSessionUpdate(prev, updates));
      const mine = ++generation.current;
      if (!updates.status) return;
      reconcileAfterStatusPush(
        projectId,
        sessionId,
        mergeRecentWindow,
        () => generation.current === mine
      );
    },
    [projectId, sessionId, mergeRecentWindow, setSession]
  );
  return { onSessionUpdated, invalidateStatus };
}
