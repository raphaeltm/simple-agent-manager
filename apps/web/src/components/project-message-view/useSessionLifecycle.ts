import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import {
  DEFAULT_CHAT_LOAD_UNTIL_MAX_PAGES,
  DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
  DEFAULT_CHAT_SESSION_MESSAGE_MAX,
} from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import { useTokenRefresh } from '../../hooks/useTokenRefresh';
import { useWorkspacePorts } from '../../hooks/useWorkspacePorts';
import type {
  ChatMessageResponse,
  ChatSessionDetailResponse,
  ChatSessionResponse,
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
  uploadSessionFiles,
} from '../../lib/api';
import { mergeMessages } from '../../lib/merge-messages';
import { isWorkspaceOperational } from '../../lib/workspace-status-utils';
import type { SessionState } from './types';
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

type FilePanelState = {
  mode: 'browse' | 'view' | 'diff' | 'git-status';
  path?: string;
  line?: number | null;
} | null;

function parsePlanContent(content: string): SessionStateSnapshot['currentPlan'] | null {
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

function getPlanFingerprint(state: SessionStateSnapshot | null | undefined): string {
  if (!state) return 'no-state';
  return state.planUpdatedAt
    ? `updated:${state.planUpdatedAt}`
    : `content:${hashPlanContent(state.currentPlan)}`;
}

export interface UseSessionLifecycleResult {
  session: ChatSessionResponse | null;
  messages: ChatMessageResponse[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  sessionState: SessionState;
  taskEmbed: ChatSessionResponse['task'] | null;
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
  detectedPorts: ReturnType<typeof useWorkspacePorts>['ports'];
  followUp: string;
  setFollowUp: (v: string) => void;
  sendingFollowUp: boolean;
  uploading: boolean;
  isResuming: boolean;
  resumeStartedAt: number | null;
  resumeError: string | null;
  clearResumeError: () => void;
  connectionState: ChatConnectionState;
  showConnectionBanner: boolean;
  retryWs: () => void;
  agentActivity: AgentActivityState;
  currentPlan: SessionStateSnapshot['currentPlan'];
  promptStartedAt: number | null;
  firstItemIndex: number;
  showScrollButton: boolean;
  setShowScrollButton: (v: boolean) => void;
  idleCountdownMs: number | null;
  filePanel: FilePanelState;
  setFilePanel: (v: FilePanelState) => void;
  handleFileClick: (path: string, line?: number | null) => void;
  handleOpenFileBrowser: () => void;
  handleOpenGitChanges: () => void;
  handleCancelPrompt: () => void;
  handleSendFollowUp: () => Promise<void>;
  handleUploadFiles: (files: FileList | File[]) => Promise<void>;
  loadMore: () => Promise<void>;
  loadUntil: (targetTimestamp: number) => Promise<void>;
  loadingMore: boolean;
  transcribeApiUrl: string;
  wsRef: React.RefObject<WebSocket | null>;
}

export function useSessionLifecycle(
  projectId: string,
  sessionId: string,
  isProvisioning: boolean,
  _onSessionMutated?: () => void
): UseSessionLifecycleResult {
  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [taskEmbed, setTaskEmbed] = useState<ChatSessionResponse['task'] | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [node, setNode] = useState<NodeResponse | null>(null);

  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivityState>('idle');
  const [currentPlan, setCurrentPlan] = useState<SessionStateSnapshot['currentPlan']>(null);
  const [promptStartedAt, setPromptStartedAt] = useState<number | null>(null);
  const clearActivity = useCallback(() => {
    setAgentActivity('idle');
    setPromptStartedAt(null);
  }, []);

  const hydratePlan = useCallback((s: SessionStateSnapshot | null | undefined) => {
    if (!s) return;
    setCurrentPlan(s.currentPlan ?? null);
  }, []);

  const { startVerifyDecayTimer, stopVerifyDecayTimer } = useActivityVerifyTimer({
    projectId,
    sessionId,
    delayMs: IDLE_TIMEOUT_MS,
    logMessage: 'Agent activity verify failed; re-arming timer',
    onVerifiedIdle: clearActivity,
    onStateSnapshot: hydratePlan,
  });

  const hydrateState = useCallback(
    (s: SessionStateSnapshot | null | undefined) => {
      if (!s) return;
      if (isWorkingActivity(s.activity)) {
        setAgentActivity(s.activity);
        setPromptStartedAt(s.promptStartedAt ?? null);
        startVerifyDecayTimer();
      } else {
        clearActivity();
        stopVerifyDecayTimer();
      }
      hydratePlan(s);
    },
    [clearActivity, hydratePlan, startVerifyDecayTimer, stopVerifyDecayTimer]
  );

  const [filePanel, setFilePanel] = useState<FilePanelState>(null);

  const handleFileClick = useCallback((path: string, line?: number | null) => {
    setFilePanel({ mode: 'view', path, line });
  }, []);
  const handleOpenFileBrowser = useCallback(() => {
    setFilePanel({ mode: 'browse', path: '.' });
  }, []);
  const handleOpenGitChanges = useCallback(() => {
    setFilePanel({ mode: 'git-status' });
  }, []);

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
    enabled: session?.status === 'active',
    onMessage: useCallback(
      (msg: ChatMessageResponse) => {
        setMessages((prev) => mergeMessages(prev, [msg], 'append'));

        if (msg.role === 'plan' && msg.content) {
          const parsed = parsePlanContent(msg.content);
          if (parsed) setCurrentPlan(parsed);
        }
        // Streaming agent output: show 'responding' heuristic, but arm the SHARED
        // verify-before-decay timer instead of a blind decay. The blind timer used to
        // clobber onAgentActivity's verified timer and flip to idle during long tool calls.
        if (msg.role !== 'user') {
          setAgentActivity('responding');
          startVerifyDecayTimer();
        }
      },
      [startVerifyDecayTimer]
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
        hydrateState(state);
      },
      [hydrateState]
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
    stopVerifyDecayTimer();
    setFirstItemIndex(VIRTUAL_START);
    setShowScrollButton(false);
  }, [sessionId, stopVerifyDecayTimer]);

  // Load session
  const loadSession = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      // Load the FULL conversation up front (server clamps to CHAT_SESSION_MESSAGE_MAX
      // and the 30 MiB RPC size guard). This keeps the timeline jump index map
      // complete and removes windowed loading for typical sessions. Oversized /
      // guard-trimmed sessions keep hasMore=true and fall back to "Load earlier".
      const data: ChatSessionDetailResponse = await getChatSession(projectId, sessionId, {
        limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX,
      });
      setSession(data.session);
      setMessages(data.messages);
      setHasMore(data.hasMore);
      if (data.session.task) setTaskEmbed(data.session.task);
      hydrateState(data.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId, hydrateState]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Fetch workspace and node details
  useEffect(() => {
    const wsId = session?.workspaceId;
    if (!wsId) return;
    if (workspace?.id === wsId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

    async function attemptFetch(attempt = 0) {
      try {
        const ws = await getWorkspace(wsId!);
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
  useEffect(() => {
    if (!session || session.status !== 'active') return;
    if (connectionState === 'connected') return;

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
          if (data.session.task) setTaskEmbed(data.session.task);
        }
        hydrateState(data.state);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      } finally {
        pollInFlight = false;
      }
    };
    const pollInterval = setInterval(() => {
      void pollActiveSession();
    }, CHAT_FALLBACK_POLL_MS);

    return () => {
      clearInterval(pollInterval);
      abortController.abort();
    };
  }, [session?.status, projectId, sessionId, hydrateState, connectionState]);

  // ── Send follow-up via REST API ──
  const handleSendFollowUp = async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    setSendingFollowUp(true);
    setAgentActivity('prompting');
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
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          sessionId,
          role: 'user',
          content: trimmed,
          toolMetadata: null,
          createdAt: Date.now(),
        },
      ]);

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
          setAgentActivity('idle');
        }
      }
    } finally {
      setSendingFollowUp(false);
    }
  };

  // Upload files
  const handleUploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;
      setUploading(true);
      try {
        const result = await uploadSessionFiles(projectId, sessionId, fileArray);
        const names = result.files.map((f) => f.name).join(', ');
        setMessages((prev) => [
          ...prev,
          {
            id: `optimistic-upload-${crypto.randomUUID()}`,
            sessionId,
            role: 'user' as const,
            content: `Uploaded ${result.files.length} file${result.files.length > 1 ? 's' : ''}: ${names}`,
            toolMetadata: null,
            createdAt: Date.now(),
          },
        ]);
      } catch (err) {
        console.error('File upload failed:', err);
      } finally {
        setUploading(false);
      }
    },
    [projectId, sessionId]
  );

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
          oldest = data.messages[0]!.createdAt;
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
        }
        setHasMore(more);
      } finally {
        setLoadingMore(false);
      }
    },
    [projectId, sessionId]
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
