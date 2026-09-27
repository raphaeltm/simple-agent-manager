import { useCallback, useEffect, useRef, useState } from 'react';

import type { WakeProgressUpdate } from '../../hooks/useChatWebSocket';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import { useTokenRefresh } from '../../hooks/useTokenRefresh';
import { useWorkspacePorts } from '../../hooks/useWorkspacePorts';
import type {
  ChatMessageResponse,
  ChatSessionDetailResponse,
  ChatSessionResponse,
  MessageCommentRealtimeEvent,
  SessionStateSnapshot,
} from '../../lib/api';
import {
  getTerminalToken,
  getTranscribeApiUrl,
  resetIdleTimer,
  sendFollowUpPrompt,
} from '../../lib/api';
import { mergeMessages } from '../../lib/merge-messages';
import { mergeRecentWindowOrRefresh } from '../../lib/message-paging';
import { isWorkspaceOperational } from '../../lib/workspace-status-utils';
import type { FilePanelState } from './session-lifecycle-helpers';
import { parsePlanContent } from './session-lifecycle-helpers';
import type { AgentActivityState } from './types';
import { deriveSessionState, IDLE_TIMEOUT_MS, isWorkingActivity } from './types';
import { useActivityVerifyTimer } from './useActivityVerifyTimer';
import { useCancelAgentPrompt } from './useCancelAgentPrompt';
import { useCompletionDockWorking } from './useCompletionDockWorking';
import { useConnectionRecovery } from './useConnectionRecovery';
import { useFallbackSessionPoll } from './useFallbackSessionPoll';
import { useSessionFileUpload } from './useSessionFileUpload';
import { useSessionInfrastructure } from './useSessionInfrastructure';
import type { UseSessionLifecycleResult } from './useSessionLifecycle.types';
import { useSessionTranscript } from './useSessionTranscript';
import { useWakeProgress } from './useWakeProgress';

export function useSessionLifecycle(
  projectId: string,
  sessionId: string,
  isProvisioning: boolean,
  _onSessionMutated?: () => void,
  onCommentEvent?: (event: MessageCommentRealtimeEvent) => void
): UseSessionLifecycleResult {
  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [taskEmbed, setTaskEmbed] = useState<ChatSessionResponse['task'] | null>(null);

  const transcript = useSessionTranscript(projectId, sessionId);
  const {
    queryClient,
    queryKey: sessionMessagesQueryKey,
    query: sessionQuery,
    messages,
    setMessages,
    messagesRef,
    hasMore,
    setHasMore,
    hasMoreRef,
    updateCachedMessages,
  } = transcript;

  const appendOptimisticMessage = useCallback(
    (message: ChatMessageResponse) => {
      setMessages((prev) => [...prev, message]);
      updateCachedMessages([message], 'append');
    },
    [updateCachedMessages]
  );
  const { uploading, handleUploadFiles } = useSessionFileUpload({
    projectId,
    sessionId,
    onOptimisticMessage: appendOptimisticMessage,
  });

  const { workspace, node } = useSessionInfrastructure(session?.workspaceId);
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivityState>('idle');
  const completionDockWorking = useCompletionDockWorking(agentActivity);
  const sleepingWakePendingRef = useRef(false);
  const [currentPlan, setCurrentPlan] = useState<SessionStateSnapshot['currentPlan']>(null);
  const [promptStartedAt, setPromptStartedAt] = useState<number | null>(null);
  const [staleNotice, setStaleNotice] = useState(false);
  const clearActivity = useCallback(() => {
    setAgentActivity('idle');
    setPromptStartedAt(null);
  }, []);
  const hydratePlan = useCallback((s: SessionStateSnapshot | null | undefined) => {
    if (!s) return;
    setCurrentPlan(s.currentPlan ?? null);
  }, []);
  const handleVerifiedStale = useCallback(() => setStaleNotice(true), []);
  const dismissStaleNotice = useCallback(() => setStaleNotice(false), []);
  const { startVerifyDecayTimer, stopVerifyDecayTimer } = useActivityVerifyTimer({
    projectId,
    sessionId,
    delayMs: IDLE_TIMEOUT_MS,
    logMessage: 'Agent activity verify failed; re-arming timer',
    onVerifiedIdle: clearActivity,
    onVerifiedStale: handleVerifiedStale,
    onStateSnapshot: hydratePlan,
  });

  const wake = useWakeProgress(sessionId);
  const { hydrateWakeProgress } = wake;

  const hydrateState = useCallback(
    (s: SessionStateSnapshot | null | undefined) => {
      if (!s) return;
      // Wake phase is folded in first so the banner has a phase to render in the
      // same commit that flips activity to 'recovering'.
      hydrateWakeProgress(s);
      if (isWorkingActivity(s.activity)) {
        setAgentActivity(s.activity);
        setPromptStartedAt(s.promptStartedAt ?? null);
        startVerifyDecayTimer();
      } else if (s.recoveryStatus === 'waking') {
        setAgentActivity('recovering');
        sleepingWakePendingRef.current = true;
      } else {
        clearActivity();
        stopVerifyDecayTimer();
      }
      hydratePlan(s);
    },
    [clearActivity, hydratePlan, hydrateWakeProgress, startVerifyDecayTimer, stopVerifyDecayTimer]
  );

  const [filePanel, setFilePanel] = useState<FilePanelState>(null);
  const handleFileClick = useCallback((path: string, line?: number | null) => {
    setFilePanel({ mode: 'view', path, line });
  }, []);
  const handleOpenFileBrowser = useCallback(() => setFilePanel({ mode: 'browse', path: '.' }), []);
  const handleOpenGitChanges = useCallback(() => setFilePanel({ mode: 'git-status' }), []);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const sessionState = session ? deriveSessionState(session) : 'terminated';
  const transcribeApiUrl = getTranscribeApiUrl();

  // ── DO WebSocket (sole message source) ──
  const {
    connectionState,
    wsRef,
    retry: retryWs,
  } = useChatWebSocket({
    projectId,
    sessionId,
    // A waking session is still `sleeping` server-side for the whole wake —
    // `wakeSession()` only flips it to `active` at the very end, after the agent
    // session is live. Gating the socket on `active` alone therefore means the
    // client holds NO connection during the exact window the wake-progress
    // broadcasts are being sent, and every phase delta is dropped.
    //
    // `isWaking` comes from the D1 hydrate, so it is known on mount and on every
    // poll. Opening the socket for that bounded window (and only then — an
    // ordinary sleeping session still connects nothing) is what makes the push
    // half of wake progress actually reach the user.
    enabled: session?.status === 'active' || wake.isWaking,
    onMessage: useCallback(
      (msg: ChatMessageResponse) => {
        setMessages((prev) => mergeMessages(prev, [msg], 'append'));
        updateCachedMessages([msg], 'append');

        if (msg.role === 'plan' && msg.content) {
          const parsed = parsePlanContent(msg.content);
          if (parsed) setCurrentPlan(parsed);
        }
        // Streaming agent output: show 'responding' heuristic, but arm the SHARED
        // verify-before-decay timer instead of a blind decay. The blind timer used to
        // clobber onAgentActivity's verified timer and flip to idle during long tool calls.
        if (msg.role !== 'user') {
          setAgentActivity('responding');
          // Fresh agent output disproves the stall — retire the notice.
          setStaleNotice(false);
          startVerifyDecayTimer();
        }
      },
      [startVerifyDecayTimer, updateCachedMessages]
    ),
    onSessionStopped: useCallback(() => {
      setSession((prev) => (prev ? { ...prev, status: 'stopped' } : prev));
      setAgentActivity('idle');
      setPromptStartedAt(null);
      // Stop any pending verify timer so it can't re-arm and flash the bar back on.
      stopVerifyDecayTimer();
    }, [stopVerifyDecayTimer]),
    onCatchUp: useCallback(
      (
        catchUpMessages: ChatMessageResponse[],
        catchUpSession: ChatSessionResponse,
        state?: SessionStateSnapshot | null
      ) => {
        setSession(catchUpSession);
        void (async () => {
          try {
            const recentDetail = {
              session: catchUpSession,
              messages: catchUpMessages,
              hasMore: hasMoreRef.current,
              state: state ?? null,
            } as ChatSessionDetailResponse;
            const current =
              queryClient.getQueryData<ChatSessionDetailResponse>(sessionMessagesQueryKey) ??
              ({
                ...recentDetail,
                messages: messagesRef.current,
                hasMore: hasMoreRef.current,
              } as ChatSessionDetailResponse);
            const merged = await mergeRecentWindowOrRefresh(
              projectId,
              sessionId,
              current,
              recentDetail
            );
            setMessages(merged.messages);
            setHasMore(merged.hasMore);
            queryClient.setQueryData<ChatSessionDetailResponse | undefined>(
              sessionMessagesQueryKey,
              (old) => ({
                ...(old ?? merged),
                ...merged,
                state: state ?? old?.state ?? merged.state,
              })
            );
          } catch {
            // Best-effort catch-up: the socket remains connected, and the next
            // explicit refresh/reconnect will retry from the current cache.
          }
        })();
        hydrateState(state);
      },
      [hydrateState, projectId, queryClient, sessionId, sessionMessagesQueryKey]
    ),
    onAgentCompleted: useCallback(
      (agentCompletedAt: number) => {
        setSession((prev) =>
          prev ? ({ ...prev, agentCompletedAt, isIdle: true } as ChatSessionResponse) : prev
        );
        setAgentActivity('idle');
        setPromptStartedAt(null);
        // Stop any pending verify timer so it can't re-arm and flash the bar back on.
        stopVerifyDecayTimer();
      },
      [stopVerifyDecayTimer]
    ),
    onAgentActivity: useCallback(
      (
        activity: 'prompting' | 'idle' | 'recovering' | 'error',
        promptStartedAt?: number | null
      ) => {
        const working = activity === 'prompting' || activity === 'recovering';
        setAgentActivity(working ? activity : 'idle');
        setPromptStartedAt(working ? (promptStartedAt ?? Date.now()) : null);
        if (working) {
          // A live working signal disproves the stall — retire the notice.
          setStaleNotice(false);
          // Arm the shared verify-before-decay timer (prevents false idle during long tool calls).
          startVerifyDecayTimer();
        } else {
          // Authoritative idle from the DO: stop any pending verify timer.
          stopVerifyDecayTimer();
        }
      },
      [startVerifyDecayTimer, stopVerifyDecayTimer]
    ),
    onSessionUpdated: useCallback(
      (updates: Partial<Pick<ChatSessionResponse, 'topic' | 'workspaceId'>>) => {
        setSession((prev) => (prev ? { ...prev, ...updates } : prev));
      },
      []
    ),
    // Pushed wake phase — arrives well ahead of the fallback poll, so the banner
    // tracks the actual wake instead of lagging a poll interval behind it.
    onWakeProgress: useCallback(
      (update: WakeProgressUpdate) => {
        wake.applyWakeProgress(update);
        if (update.recoveryStatus !== 'waking') {
          // The replacement runner is live (or gave up). Release the local wake
          // latch so the fallback poll is allowed to publish authoritative state
          // again instead of being suppressed as "stale sleeping state".
          sleepingWakePendingRef.current = false;
        }
      },
      [wake]
    ),
    onCommentEvent,
  });

  // Connection recovery (banner debounce, idle timer, auto-resume)
  const recovery = useConnectionRecovery({
    sessionId,
    projectId,
    sessionState,
    connectionState,
    session,
    isProvisioning,
    setSession,
  });

  // Reset the scroll button and idle timer on session change; cleanup on unmount.
  // (The transcript resets its own virtual-scroll anchor.)
  useEffect(() => {
    sleepingWakePendingRef.current = false;
    stopVerifyDecayTimer();
    setShowScrollButton(false);
  }, [sessionId, stopVerifyDecayTimer]);

  // The transcript mirrors the query's messages; this mirrors its session and state.
  useEffect(() => {
    if (!sessionQuery.data) return;

    setSession(sessionQuery.data.session);
    setTaskEmbed(sessionQuery.data.session.task ?? null);
    const serverStillHasStaleSleepingState =
      sleepingWakePendingRef.current &&
      sessionQuery.data.session.status === 'sleeping' &&
      !isWorkingActivity(sessionQuery.data.state?.activity);
    if (serverStillHasStaleSleepingState) {
      hydratePlan(sessionQuery.data.state);
      // The guard exists to stop a stale `idle` activity from erasing the user's
      // wake feedback — NOT to discard wake progress. Its condition holds for most
      // of a wake (status stays `sleeping`, activity stays `idle` until the agent
      // actually starts), so routing around `hydrateState` without this would drop
      // every phase update and leave `isWaking` false for the entire wake.
      hydrateWakeProgress(sessionQuery.data.state);
    } else {
      if (
        sessionQuery.data.session.status !== 'sleeping' ||
        isWorkingActivity(sessionQuery.data.state?.activity)
      ) {
        sleepingWakePendingRef.current = false;
      }
      hydrateState(sessionQuery.data.state);
    }
  }, [
    sessionQuery.data,
    sessionQuery.error,
    sessionQuery.isPending,
    hydrateState,
    hydratePlan,
    hydrateWakeProgress,
  ]);

  // Token refresh for port scanning
  const isWorkspaceRunning = isWorkspaceOperational(workspace?.status);
  const tokenRefreshFetchToken = useCallback(async () => {
    const wsId = session?.workspaceId;
    if (!wsId) throw new Error('No workspace ID');
    return getTerminalToken(wsId);
  }, [session?.workspaceId]);

  const { token: terminalToken } = useTokenRefresh({
    fetchToken: tokenRefreshFetchToken,
    enabled: !!session?.workspaceId && isWorkspaceRunning,
  });

  const { ports: detectedPorts } = useWorkspacePorts(
    workspace?.url ?? undefined,
    session?.workspaceId ?? undefined,
    terminalToken ?? undefined,
    workspace?.status
  );

  useFallbackSessionPoll({
    projectId,
    sessionId,
    session,
    connectionState,
    transcript,
    sleepingWakePendingRef,
    setSession,
    setTaskEmbed,
    hydrateState,
    hydratePlan,
    hydrateWakeProgress,
  });

  // ── Send follow-up via REST API ──
  const handleSendFollowUp = async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    const wakingSleepingSession = sessionState === 'sleeping';
    if (wakingSleepingSession) sleepingWakePendingRef.current = true;
    setSendingFollowUp(true);
    setAgentActivity('prompting');
    setStaleNotice(false);
    // A new turn supersedes any failed interrupt of the previous one — leaving
    // the old error visible would attach it to work it has nothing to do with.
    clearCancelError();
    try {
      if (sessionState === 'idle') {
        resetIdleTimer(projectId, sessionId)
          .then((result) => {
            if (result.cleanupAt) {
              setSession((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  cleanupAt: result.cleanupAt,
                  isIdle: false,
                  agentCompletedAt: null,
                } as ChatSessionResponse;
              });
            }
          })
          .catch(() => {});
      }

      // Optimistic user message
      const optimisticId = `optimistic-${crypto.randomUUID()}`;
      const optimisticMessage: ChatMessageResponse = {
        id: optimisticId,
        sessionId,
        role: 'user',
        content: trimmed,
        toolMetadata: null,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, optimisticMessage]);
      updateCachedMessages([optimisticMessage], 'append');

      // Persist via DO WebSocket
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'message.send',
            sessionId,
            content: trimmed,
            role: 'user',
          })
        );
      }

      // For idle sessions, resume first then send the prompt. The composer is
      // cleared only when delivery is confirmed (onDelivered); a failed resume
      // or delivery resets the working state and keeps the typed text as the
      // manual-retry affordance (onFailed).
      if (sessionState === 'idle' && session?.workspaceId && session?.agentSessionId) {
        recovery.resumeAndSend(trimmed, {
          onDelivered: () => {
            setFollowUp('');
          },
          onFailed: () => {
            setAgentActivity('idle');
          },
        });
      } else {
        // Forward prompt to the running agent via REST API
        try {
          await sendFollowUpPrompt(projectId, sessionId, trimmed);
          // Delivery confirmed — clear any stale recovery banner and the composer.
          recovery.clearResumeError();
          setFollowUp('');
        } catch (err) {
          // reportDeliveryError terminates the session on a terminal RUNTIME_STOPPED
          // (composer disabled) or shows the recovery banner otherwise. Reset the
          // working state and keep the composer text so the user can retry.
          recovery.reportDeliveryError(err);
          if (wakingSleepingSession) sleepingWakePendingRef.current = false;
          setAgentActivity('idle');
        }
      }
    } finally {
      setSendingFollowUp(false);
    }
  };

  // Upload files
  const onCancelled = useCallback(() => setAgentActivity('idle'), []);
  const {
    cancelling,
    cancelError,
    cancelPrompt: handleCancelPrompt,
    clearCancelError,
  } = useCancelAgentPrompt({
    projectId,
    sessionId,
    enabled: completionDockWorking,
    onCancelled,
  });

  return {
    session,
    messages,
    hasMore,
    loading: transcript.loading,
    error: transcript.error,
    setError: transcript.setError,
    sessionState,
    taskEmbed,
    workspace,
    node,
    detectedPorts,
    followUp,
    setFollowUp,
    sendingFollowUp,
    uploading,
    isResuming: recovery.isResuming,
    resumeStartedAt: recovery.resumeStartedAt,
    resumeError: recovery.resumeError,
    clearResumeError: recovery.clearResumeError,
    connectionState,
    showConnectionBanner: recovery.showConnectionBanner,
    retryWs,
    agentActivity,
    completionDockWorking,
    /** True while a wake is in flight (hydrated from D1 or pushed over the socket). */
    isWaking: wake.isWaking,
    /** Current wake phase, or null before the replacement runner reports a step. */
    wakePhase: wake.wakePhase,
    staleNotice,
    dismissStaleNotice,
    currentPlan,
    promptStartedAt,
    firstItemIndex: transcript.firstItemIndex,
    showScrollButton,
    setShowScrollButton,
    idleCountdownMs: recovery.idleCountdownMs,
    filePanel,
    setFilePanel,
    handleFileClick,
    handleOpenFileBrowser,
    handleOpenGitChanges,
    handleCancelPrompt,
    cancelling,
    cancelError,
    handleSendFollowUp,
    handleUploadFiles,
    loadMore: transcript.loadMore,
    loadUntil: transcript.loadUntil,
    loadingMore: transcript.loadingMore,
    transcribeApiUrl,
    wsRef,
  };
}
