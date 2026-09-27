import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from 'react';

import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import { useDocumentVisible } from '../../hooks/useVisibilityAwarePoll';
import type { ChatSessionResponse, SessionStateSnapshot } from '../../lib/api';
import { fetchNewestPage } from '../../lib/message-paging';
import { getPlanFingerprint } from './session-lifecycle-helpers';
import { CHAT_FALLBACK_POLL_MS, isWorkingActivity } from './types';
import type { SessionTranscript } from './useSessionTranscript';

type SnapshotHydrator = (s: SessionStateSnapshot | null | undefined) => void;

interface FallbackSessionPollInput {
  projectId: string;
  sessionId: string;
  session: ChatSessionResponse | null;
  connectionState: ChatConnectionState;
  mergeRecentWindow: SessionTranscript['mergeRecentWindow'];
  /** Set while a user-triggered wake is in flight; see `serverStillHasStaleSleepingState`. */
  sleepingWakePendingRef: MutableRefObject<boolean>;
  setSession: Dispatch<SetStateAction<ChatSessionResponse | null>>;
  setTaskEmbed: Dispatch<SetStateAction<ChatSessionResponse['task'] | null>>;
  hydrateState: SnapshotHydrator;
  hydratePlan: SnapshotHydrator;
  hydrateWakeProgress: SnapshotHydrator;
}

/**
 * Degraded fallback while the DO WebSocket is unavailable. Connected active
 * sessions rely on WebSocket events and reconnect catch-up instead of polling
 * the full session detail endpoint.
 */
export function useFallbackSessionPoll({
  projectId,
  sessionId,
  session,
  connectionState,
  mergeRecentWindow,
  sleepingWakePendingRef,
  setSession,
  setTaskEmbed,
  hydrateState,
  hydratePlan,
  hydrateWakeProgress,
}: FallbackSessionPollInput): void {
  const documentVisible = useDocumentVisible();
  // Tracks the hidden→visible edge so the effect below can tell a visibility
  // return (which must catch up immediately) apart from its other re-run causes.
  // Updated inside the effect, never during render.
  const wasVisibleRef = useRef(documentVisible);

  useEffect(() => {
    const becameVisible = documentVisible && !wasVisibleRef.current;
    wasVisibleRef.current = documentVisible;

    if (!session || !['active', 'sleeping'].includes(session.status)) return;
    if (session.status === 'active' && connectionState === 'connected') return;
    // Same reasoning as the chat socket's gate in `useSessionLifecycle`, applied
    // to the tab: nobody is reading this session while it is hidden, and this
    // poll fetches the full session detail (heavier than the session list).
    if (!documentVisible) return;

    const abortController = new AbortController();
    let lastPollFingerprint = '';
    let pollInFlight = false;
    const pollActiveSession = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        // Poll only the newest window — the merge keeps every older loaded row,
        // so polling must NOT re-fetch the whole conversation.
        const data = await fetchNewestPage(projectId, sessionId, abortController.signal);
        if (data.session.id !== sessionId) return;
        const newLastId = data.messages[data.messages.length - 1]?.id ?? '';
        const taskStatus = data.session.task?.status ?? '';
        const agentSessId = data.session.agentSessionId ?? '';
        const planFingerprint = getPlanFingerprint(data.state);
        const fingerprint = `${data.messages.length}:${newLastId}:${data.session.status}:${taskStatus}:${agentSessId}:${planFingerprint}`;
        if (fingerprint !== lastPollFingerprint) {
          lastPollFingerprint = fingerprint;
          setSession(data.session);
          await mergeRecentWindow(data, abortController.signal);
          if (data.session.task) setTaskEmbed(data.session.task);
        }
        const wakeAttemptFailed =
          sleepingWakePendingRef.current &&
          data.session.status === 'sleeping' &&
          (['failed', 'cancelled'].includes(data.session.task?.status ?? '') ||
            data.session.attention?.kind === 'wake_failed');
        if (wakeAttemptFailed) {
          sleepingWakePendingRef.current = false;
        }
        const serverStillHasStaleSleepingState =
          sleepingWakePendingRef.current &&
          data.session.status === 'sleeping' &&
          !isWorkingActivity(data.state?.activity);
        if (serverStillHasStaleSleepingState) {
          // Durable prompt acceptance precedes replacement-runtime provisioning.
          // During that window the sleeping session's last persisted activity is
          // still idle; do not let fallback polling erase the user's wake feedback.
          hydratePlan(data.state);
          // Wake progress must survive this branch — see the matching comment on
          // the mount-hydrate path. This is the poll that carries phase updates
          // for a user-triggered wake, which is the common trigger.
          hydrateWakeProgress(data.state);
        } else {
          if (data.session.status !== 'sleeping' || isWorkingActivity(data.state?.activity)) {
            sleepingWakePendingRef.current = false;
          }
          hydrateState(data.state);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      } finally {
        pollInFlight = false;
      }
    };
    // Catch up immediately when the tab regains visibility — the poll was
    // suspended while hidden, so waiting a full interval would show a stale
    // conversation at exactly the moment the user looks at it. Scoped to the
    // visibility edge: this effect's other re-run causes (session status,
    // connection state) keep their pre-existing interval-only behaviour.
    if (becameVisible) void pollActiveSession();

    const pollInterval = setInterval(() => {
      void pollActiveSession();
    }, CHAT_FALLBACK_POLL_MS);

    return () => {
      clearInterval(pollInterval);
      abortController.abort();
    };
  }, [
    session?.status,
    projectId,
    sessionId,
    hydrateState,
    connectionState,
    documentVisible,
    mergeRecentWindow,
  ]);
}
