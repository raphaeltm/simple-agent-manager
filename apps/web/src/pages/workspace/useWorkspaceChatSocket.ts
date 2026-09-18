/**
 * DO WebSocket + activity derivation for the workspace chat surface.
 *
 * Extracted from `WorkspaceChatView` so that view stays under the file-size
 * ceiling (`.claude/rules/18`). It is the small sibling of
 * `useSessionLifecycle`: same job — own the socket, derive `agentActivity` from
 * the message flow, and keep the verify-before-decay timer armed — for a view
 * that has no task embed, no comments and no timeline.
 *
 * Message and session state stay in the view and are written through the
 * setters passed in, because the composer, pagination and file upload there all
 * write to them too.
 */
import { type Dispatch, type SetStateAction, useCallback, useState } from 'react';

import type { AgentActivityState } from '../../components/project-message-view/types';
import { isWorkingActivity } from '../../components/project-message-view/types';
import { useActivityVerifyTimer } from '../../components/project-message-view/useActivityVerifyTimer';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import type {
  ChatMessageResponse,
  ChatSessionResponse,
  SessionStateSnapshot,
} from '../../lib/api/sessions';
import { mergeMessages } from '../../lib/merge-messages';

/** Seconds of silence after last agent row before returning to idle. */
const IDLE_TIMEOUT_MS = 3000;

/**
 * Message roles that prove the agent is producing output.
 *
 * Project chat uses `msg.role !== 'user'` for the same purpose
 * (`useSessionLifecycle.ts`). An explicit allow-set is used here because that
 * negation also admits `system` rows, which are SAM-injected lifecycle/log
 * messages rather than agent output.
 */
const AGENT_OUTPUT_ROLES = new Set(['assistant', 'thinking', 'tool']);

interface UseWorkspaceChatSocketOptions {
  projectId: string;
  sessionId: string;
  /** The socket only opens for an active session. */
  sessionStatus: string | undefined;
  setMessages: Dispatch<SetStateAction<ChatMessageResponse[]>>;
  setSession: Dispatch<SetStateAction<ChatSessionResponse | null>>;
}

export interface UseWorkspaceChatSocketResult extends Pick<
  ReturnType<typeof useChatWebSocket>,
  'connectionState' | 'wsRef'
> {
  agentActivity: AgentActivityState;
  /** The composer sets `prompting` on send and `idle` when the agent is offline. */
  setAgentActivity: Dispatch<SetStateAction<AgentActivityState>>;
  /** Apply a persisted state snapshot (initial load and socket catch-up). */
  hydrateActivity: (state: SessionStateSnapshot | null | undefined) => void;
  stopVerifyDecayTimer: () => void;
}

export function useWorkspaceChatSocket({
  projectId,
  sessionId,
  sessionStatus,
  setMessages,
  setSession,
}: UseWorkspaceChatSocketOptions): UseWorkspaceChatSocketResult {
  const [agentActivity, setAgentActivity] = useState<AgentActivityState>('idle');

  const clearActivity = useCallback(() => {
    setAgentActivity('idle');
  }, []);

  const { startVerifyDecayTimer, stopVerifyDecayTimer } = useActivityVerifyTimer({
    projectId,
    sessionId,
    delayMs: IDLE_TIMEOUT_MS,
    logMessage: 'Workspace chat activity verify failed; re-arming timer',
    onVerifiedIdle: clearActivity,
  });

  const hydrateActivity = useCallback(
    (state: SessionStateSnapshot | null | undefined) => {
      if (!state) return;
      if (isWorkingActivity(state.activity)) {
        setAgentActivity(state.activity);
        startVerifyDecayTimer();
      } else {
        clearActivity();
        stopVerifyDecayTimer();
      }
    },
    [clearActivity, startVerifyDecayTimer, stopVerifyDecayTimer]
  );

  // ── DO WebSocket for real-time message updates (SOLE message source) ──
  const { connectionState, wsRef } = useChatWebSocket({
    projectId,
    sessionId,
    enabled: sessionStatus === 'active',
    onMessage: useCallback(
      (msg: ChatMessageResponse) => {
        setMessages((prev) => mergeMessages(prev, [msg], 'append'));

        /*
         * Any agent output means the agent is working — not just its prose.
         * This used to key on `role === 'assistant'` alone, so a tool-only burst
         * (the common shape of a long turn: think → tool → think → tool) never
         * lit the indicator here, and the tail activity card never showed motion
         * even while calls were streaming in.
         *
         * `system` and `user` rows stay out deliberately. `system` rows are
         * SAM-injected lifecycle and build-log messages, not agent output, and
         * one arriving after `onSessionStopped` would re-light the indicator on
         * a stopped session. `plan` needs no entry of its own: a plan row only
         * ever arrives alongside the thinking/tool rows of the same turn.
         *
         * Still arms the SHARED verify-before-decay timer rather than a blind
         * decay, so a long tool call cannot flip the UI to idle underneath it.
         */
        if (AGENT_OUTPUT_ROLES.has(msg.role)) {
          setAgentActivity('responding');
          startVerifyDecayTimer();
        }
      },
      [startVerifyDecayTimer]
    ),
    onSessionStopped: useCallback(() => {
      setSession((prev) => (prev ? { ...prev, status: 'stopped' } : prev));
      setAgentActivity('idle');
    }, []),
    onCatchUp: useCallback(
      (
        catchUpMsgs: ChatMessageResponse[],
        catchUpSession: ChatSessionResponse,
        state?: SessionStateSnapshot | null
      ) => {
        setSession(catchUpSession);
        setMessages((prev) => mergeMessages(prev, catchUpMsgs, 'replace'));
        hydrateActivity(state);
      },
      [hydrateActivity]
    ),
    onAgentCompleted: useCallback((agentCompletedAt: number) => {
      setSession((prev) =>
        prev ? ({ ...prev, agentCompletedAt, isIdle: true } as ChatSessionResponse) : prev
      );
      setAgentActivity('idle');
    }, []),
    onAgentActivity: useCallback(
      (activity: 'prompting' | 'idle' | 'recovering' | 'error') => {
        if (activity === 'prompting' || activity === 'recovering') {
          setAgentActivity(activity);
          startVerifyDecayTimer();
        } else {
          clearActivity();
          stopVerifyDecayTimer();
        }
      },
      [clearActivity, startVerifyDecayTimer, stopVerifyDecayTimer]
    ),
  });

  return {
    connectionState,
    wsRef,
    agentActivity,
    setAgentActivity,
    hydrateActivity,
    stopVerifyDecayTimer,
  };
}
