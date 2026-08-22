import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import {
  DEFAULT_CHAT_LOAD_UNTIL_MAX_PAGES,
  DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
  DEFAULT_CHAT_SESSION_MESSAGE_MAX,
} from '@simple-agent-manager/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { WakeProgressUpdate } from '../../hooks/useChatWebSocket';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useTokenRefresh } from '../../hooks/useTokenRefresh';
import { useDocumentVisible } from '../../hooks/useVisibilityAwarePoll';
import { useWorkspacePorts } from '../../hooks/useWorkspacePorts';
import type {
  ChatMessageResponse,
  ChatSessionDetailResponse,
  ChatSessionResponse,
  MessageCommentRealtimeEvent,
  SessionStateSnapshot,
} from '../../lib/api';
import {
  cancelAgentPrompt,
  getChatSession,
  getNode,
  getTerminalToken,
  getTranscribeApiUrl,
  getWorkspace,
  resetIdleTimer,
  sendFollowUpPrompt,
} from '../../lib/api';
import { mergeMessages } from '../../lib/merge-messages';
import { chatQueryKeys, chatSessionMessagesQueryOptions } from '../../lib/query-options';
import { isWorkspaceOperational } from '../../lib/workspace-status-utils';
import type { FilePanelState } from './session-lifecycle-helpers';
import {
  getPlanFingerprint,
  mergeSessionDetailMessages,
  parsePlanContent,
} from './session-lifecycle-helpers';
import type { AgentActivityState } from './types';
import {
  CHAT_FALLBACK_POLL_MS,
  deriveSessionState,
  IDLE_TIMEOUT_MS,
  isWorkingActivity,
  VIRTUAL_START,
} from './types';
import { useActivityVerifyTimer } from './useActivityVerifyTimer';
import { useConnectionRecovery } from './useConnectionRecovery';
import { useSessionFileUpload } from './useSessionFileUpload';
import type { UseSessionLifecycleResult } from './useSessionLifecycle.types';
import { useWakeProgress } from './useWakeProgress';

export function useSessionLifecycle(
  projectId: string,
  sessionId: string,
  isProvisioning: boolean,
  _onSessionMutated?: () => void,
  onCommentEvent?: (event: MessageCommentRealtimeEvent) => void
): UseSessionLifecycleResult {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const sessionMessagesQueryKey = useMemo(
    () => chatQueryKeys.sessionMessages(queryScope, projectId, sessionId),
    [projectId, queryScope, sessionId]
  );
  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [taskEmbed, setTaskEmbed] = useState<ChatSessionResponse['task'] | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionQuery = useQuery({
    ...chatSessionMessagesQueryOptions(queryScope, projectId, sessionId),
    enabled: Boolean(queryScope && projectId && sessionId),
    queryFn: async ({ signal }) => {
      const cached = queryClient.getQueryData<ChatSessionDetailResponse>(sessionMessagesQueryKey);
      const latestCachedAt = cached?.messages.at(-1)?.createdAt;
      if (cached && typeof latestCachedAt === 'number') {
        const delta = await getChatSession(projectId, sessionId, {
          signal,
          after: latestCachedAt,
        });
        return {
          ...delta,
          messages: mergeMessages(cached.messages, delta.messages, 'append'),
          hasMore: cached.hasMore || delta.hasMore,
        };
      }

      return getChatSession(projectId, sessionId, {
        signal,
        limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX,
      });
    },
  });

  // Refs mirror the latest messages/hasMore so imperative loaders (loadUntil)
  // can read current state without stale closures.
  const messagesRef = useRef<ChatMessageResponse[]>([]);
  const hasMoreRef = useRef(false);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const updateCachedMessages = useCallback(
    (incoming: ChatMessageResponse[], strategy: 'replace' | 'append' | 'prepend') => {
      if (!queryScope) return;
      // TODO: Add size-based cache eviction — no cap for now, optimize later
      queryClient.setQueryData<ChatSessionDetailResponse | undefined>(
        sessionMessagesQueryKey,
        (old) => mergeSessionDetailMessages(old, incoming, strategy)
      );
    },
    [queryClient, queryScope, sessionMessagesQueryKey]
  );

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

  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [node, setNode] = useState<NodeResponse | null>(null);
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivityState>('idle');
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
  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUAL_START);
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
        setMessages((prev) => mergeMessages(prev, catchUpMessages, 'replace'));
        queryClient.setQueryData<ChatSessionDetailResponse | undefined>(
          sessionMessagesQueryKey,
          (old) =>
            old
              ? {
                  ...old,
                  session: catchUpSession,
                  messages: mergeMessages(old.messages, catchUpMessages, 'replace'),
                  state: state ?? old.state,
                }
              : old
        );
        hydrateState(state);
      },
      [hydrateState, queryClient, sessionMessagesQueryKey]
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

  // Reset virtual scroll and idle timer on session change; cleanup on unmount
  useEffect(() => {
    sleepingWakePendingRef.current = false;
    stopVerifyDecayTimer();
    setFirstItemIndex(VIRTUAL_START);
    setShowScrollButton(false);
  }, [sessionId, stopVerifyDecayTimer]);

  useEffect(() => {
    setLoading(sessionQuery.isPending && sessionQuery.data === undefined);
    if (sessionQuery.error && sessionQuery.data === undefined) {
      setError(
        sessionQuery.error instanceof Error ? sessionQuery.error.message : 'Failed to load session'
      );
    }
    if (!sessionQuery.data) return;

    setError(null);
    setSession(sessionQuery.data.session);
    setMessages(sessionQuery.data.messages);
    setHasMore(sessionQuery.data.hasMore);
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

  // Fetch workspace and node details
  useEffect(() => {
    const wsId = session?.workspaceId;
    if (!wsId) return;
    if (workspace?.id === wsId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

    async function attemptFetch(attempt = 0) {
      if (!wsId) return;
      try {
        const ws = await getWorkspace(wsId);
        if (cancelled) return;
        setWorkspace(ws);
        if (ws.nodeId) {
          const nd = await getNode(ws.nodeId);
          if (!cancelled) setNode(nd);
        }
      } catch {
        if (cancelled) return;
        if (attempt < RETRY_DELAYS_MS.length) {
          retryTimer = setTimeout(() => attemptFetch(attempt + 1), RETRY_DELAYS_MS[attempt]);
        }
      }
    }

    attemptFetch();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [session?.workspaceId, workspace?.id]);

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
    isWorkspaceRunning
  );

  // Degraded fallback while the DO WebSocket is unavailable. Connected active
  // sessions rely on WebSocket events and reconnect catch-up instead of polling
  // the full session detail endpoint.
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
    // Same reasoning as the WebSocket gate above, applied to the tab: nobody is
    // reading this session while it is hidden, and this poll fetches the full
    // session detail (heavier than the session list).
    if (!documentVisible) return;

    const abortController = new AbortController();
    let lastPollFingerprint = '';
    let pollInFlight = false;
    const pollActiveSession = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        // Poll only the most-recent window — mergeReplace preserves the fully
        // loaded history, so polling must NOT re-fetch the whole conversation.
        const data: ChatSessionDetailResponse = await getChatSession(projectId, sessionId, {
          signal: abortController.signal,
          limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
        });
        if (data.session.id !== sessionId) return;
        const newLastId = data.messages[data.messages.length - 1]?.id ?? '';
        const taskStatus = data.session.task?.status ?? '';
        const agentSessId = data.session.agentSessionId ?? '';
        const planFingerprint = getPlanFingerprint(data.state);
        const fingerprint = `${data.messages.length}:${newLastId}:${data.session.status}:${taskStatus}:${agentSessId}:${planFingerprint}`;
        if (fingerprint !== lastPollFingerprint) {
          lastPollFingerprint = fingerprint;
          setSession(data.session);
          setMessages((prev) => mergeMessages(prev, data.messages, 'replace'));
          queryClient.setQueryData<ChatSessionDetailResponse | undefined>(
            sessionMessagesQueryKey,
            (old) =>
              old
                ? {
                    ...data,
                    messages: mergeMessages(old.messages, data.messages, 'replace'),
                  }
                : data
          );
          if (data.session.task) setTaskEmbed(data.session.task);
        }
        const wakeAttemptFailed =
          sleepingWakePendingRef.current &&
          data.session.status === 'sleeping' &&
          ['failed', 'cancelled'].includes(data.session.task?.status ?? '');
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
    queryClient,
    sessionMessagesQueryKey,
  ]);

  // ── Send follow-up via REST API ──
  const handleSendFollowUp = async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    const wakingSleepingSession = sessionState === 'sleeping';
    if (wakingSleepingSession) sleepingWakePendingRef.current = true;
    setSendingFollowUp(true);
    setAgentActivity('prompting');
    setStaleNotice(false);
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
  // Cancel the current in-flight prompt via REST API
  const cancellingRef = useRef(false);
  const handleCancelPrompt = useCallback(() => {
    if (agentActivity === 'idle' || cancellingRef.current) return;
    cancellingRef.current = true;
    cancelAgentPrompt(projectId, sessionId)
      .then(() => {
        setAgentActivity('idle');
      })
      .catch(() => {
        // Network/server error — keep spinner visible so user can retry
      })
      .finally(() => {
        cancellingRef.current = false;
      });
  }, [agentActivity, projectId, sessionId]);

  // Load more (pagination)
  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    const firstMessage = messages[0];
    if (!firstMessage) return;

    setLoadingMore(true);
    try {
      const data = await getChatSession(projectId, sessionId, {
        before: firstMessage.createdAt,
      });
      setMessages((prev) => {
        const merged = mergeMessages(prev, data.messages, 'prepend');
        const actualAdded = merged.length - prev.length;
        setFirstItemIndex((fi) => fi - actualAdded);
        return merged;
      });
      updateCachedMessages(data.messages, 'prepend');
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  };

  // Load older pages until a target timestamp is covered (or no more history).
  // Used by timeline jump-to-message for the rare oversized/guard-trimmed session
  // where the target predates the loaded window, so a jump never dead-clicks.
  const loadUntil = useCallback(
    async (targetTimestamp: number) => {
      let oldest = messagesRef.current[0]?.createdAt ?? Infinity;
      if (oldest <= targetTimestamp) return;
      let more = hasMoreRef.current;
      if (!more) return;

      setLoadingMore(true);
      try {
        let before: number | undefined = oldest === Infinity ? undefined : oldest;
        const accumulated: ChatMessageResponse[] = [];
        // Safety bound: never loop unbounded even if the server misreports hasMore.
        const maxPages =
          Number.parseInt(import.meta.env.VITE_CHAT_LOAD_UNTIL_MAX_PAGES || '', 10) ||
          DEFAULT_CHAT_LOAD_UNTIL_MAX_PAGES;
        let pages = 0;
        while (more && oldest > targetTimestamp && pages++ < maxPages) {
          const data = await getChatSession(projectId, sessionId, {
            before,
            limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
          });
          if (data.messages.length === 0) {
            more = false;
            break;
          }
          accumulated.unshift(...data.messages);
          const firstMessage = data.messages[0];
          if (!firstMessage) break; // Unreachable — the length check above guarantees this.
          oldest = firstMessage.createdAt;
          before = oldest;
          more = data.hasMore;
        }
        if (accumulated.length > 0) {
          setMessages((prev) => {
            const merged = mergeMessages(prev, accumulated, 'prepend');
            const actualAdded = merged.length - prev.length;
            setFirstItemIndex((fi) => fi - actualAdded);
            return merged;
          });
          updateCachedMessages(accumulated, 'prepend');
        }
        setHasMore(more);
      } finally {
        setLoadingMore(false);
      }
    },
    [projectId, sessionId, updateCachedMessages]
  );

  return {
    session,
    messages,
    hasMore,
    loading,
    error,
    setError,
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
    /** True while a wake is in flight (hydrated from D1 or pushed over the socket). */
    isWaking: wake.isWaking,
    /** Current wake phase, or null before the replacement runner reports a step. */
    wakePhase: wake.wakePhase,
    staleNotice,
    dismissStaleNotice,
    currentPlan,
    promptStartedAt,
    firstItemIndex,
    showScrollButton,
    setShowScrollButton,
    idleCountdownMs: recovery.idleCountdownMs,
    filePanel,
    setFilePanel,
    handleFileClick,
    handleOpenFileBrowser,
    handleOpenGitChanges,
    handleCancelPrompt,
    handleSendFollowUp,
    handleUploadFiles,
    loadMore,
    loadUntil,
    loadingMore,
    transcribeApiUrl,
    wsRef,
  };
}
