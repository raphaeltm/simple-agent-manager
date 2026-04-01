import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useState } from 'react';

import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import type { UseProjectAgentSessionReturn } from '../../hooks/useProjectAgentSession';
import { useProjectAgentSession } from '../../hooks/useProjectAgentSession';
import { useTokenRefresh } from '../../hooks/useTokenRefresh';
import { useWorkspacePorts } from '../../hooks/useWorkspacePorts';
import type { ChatMessageResponse, ChatSessionDetailResponse, ChatSessionResponse } from '../../lib/api';
import { getChatSession, getNode, getTerminalToken, getTranscribeApiUrl, getWorkspace, resetIdleTimer, resumeAgentSession, uploadSessionFiles } from '../../lib/api';
import { mergeMessages } from '../../lib/merge-messages';
import type { SessionState } from './types';
import { deriveSessionState,VIRTUAL_START } from './types';
import { useConnectionRecovery } from './useConnectionRecovery';

export interface UseSessionLifecycleResult {
  // Session state
  session: ChatSessionResponse | null;
  messages: ChatMessageResponse[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  sessionState: SessionState;

  // Task embed
  taskEmbed: ChatSessionResponse['task'] | null;

  // Workspace context
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
  detectedPorts: ReturnType<typeof useWorkspacePorts>['ports'];

  // Follow-up state
  followUp: string;
  setFollowUp: (v: string) => void;
  sendingFollowUp: boolean;
  uploading: boolean;

  // Resume state
  isResuming: boolean;
  resumeError: string | null;

  // Connection state
  connectionState: ChatConnectionState;
  showConnectionBanner: boolean;
  retryWs: () => void;

  // ACP session
  agentSession: UseProjectAgentSessionReturn;
  acpGrace: boolean;
  committedToDoViewRef: React.RefObject<boolean>;

  // Scroll state
  firstItemIndex: number;
  showScrollButton: boolean;
  setShowScrollButton: (v: boolean) => void;

  // Idle timer
  idleCountdownMs: number | null;

  // File panel
  filePanel: { mode: 'browse' | 'view' | 'diff' | 'git-status'; path?: string; line?: number | null } | null;
  setFilePanel: (v: { mode: 'browse' | 'view' | 'diff' | 'git-status'; path?: string; line?: number | null } | null) => void;
  handleFileClick: (path: string, line?: number | null) => void;
  handleOpenFileBrowser: () => void;
  handleOpenGitChanges: () => void;

  // Actions
  handleSendFollowUp: () => Promise<void>;
  handleUploadFiles: (files: FileList | File[]) => Promise<void>;
  loadMore: () => Promise<void>;
  loadingMore: boolean;

  // Misc
  transcribeApiUrl: string;
  wsRef: React.RefObject<WebSocket | null>;
}

export function useSessionLifecycle(
  projectId: string,
  sessionId: string,
  isProvisioning: boolean,
  _onSessionMutated?: () => void,
): UseSessionLifecycleResult {
  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [taskEmbed, setTaskEmbed] = useState<ChatSessionResponse['task'] | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Workspace & node context
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [node, setNode] = useState<NodeResponse | null>(null);

  // Follow-up input state
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [uploading, setUploading] = useState(false);

  // File panel
  const [filePanel, setFilePanel] = useState<{
    mode: 'browse' | 'view' | 'diff' | 'git-status';
    path?: string;
    line?: number | null;
  } | null>(null);

  const handleFileClick = useCallback((path: string, line?: number | null) => {
    setFilePanel({ mode: 'view', path, line });
  }, []);
  const handleOpenFileBrowser = useCallback(() => {
    setFilePanel({ mode: 'browse', path: '.' });
  }, []);
  const handleOpenGitChanges = useCallback(() => {
    setFilePanel({ mode: 'git-status' });
  }, []);

  // Virtual scroll
  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUAL_START);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const sessionState = session ? deriveSessionState(session) : 'terminated';
  const transcribeApiUrl = getTranscribeApiUrl();
  const agentSessionId = session?.agentSessionId ?? null;

  // WebSocket
  const { connectionState, wsRef, retry: retryWs } = useChatWebSocket({
    projectId,
    sessionId,
    enabled: session?.status === 'active',
    onMessage: useCallback((msg: ChatMessageResponse) => {
      setMessages((prev) => mergeMessages(prev, [msg], 'append'));
    }, []),
    onSessionStopped: useCallback(() => {
      setSession((prev) => prev ? { ...prev, status: 'stopped' } : prev);
    }, []),
    onCatchUp: useCallback((catchUpMessages: ChatMessageResponse[], catchUpSession: ChatSessionResponse, catchUpHasMore: boolean) => {
      setSession(catchUpSession);
      setMessages((prev) => mergeMessages(prev, catchUpMessages, 'replace'));
      setHasMore(catchUpHasMore);
    }, []),
    onAgentCompleted: useCallback((agentCompletedAt: number) => {
      setSession((prev) => prev ? { ...prev, agentCompletedAt, isIdle: true } as ChatSessionResponse : prev);
    }, []),
  });

  // ACP agent session
  const agentSession = useProjectAgentSession({
    workspaceId: session?.workspaceId ?? null,
    sessionId: agentSessionId ?? sessionId,
    enabled: (sessionState === 'active' || sessionState === 'idle') && agentSessionId !== null,
    preferredAgentType: undefined,
  });

  // Connection recovery (auto-resume, ACP recovery, grace period, idle timer, banner debounce)
  const recovery = useConnectionRecovery({
    sessionId,
    projectId,
    sessionState,
    connectionState,
    agentSession,
    agentSessionId,
    session,
    isProvisioning,
    setSession,
  });

  // Reset virtual scroll on session change
  useEffect(() => {
    setFirstItemIndex(VIRTUAL_START);
    setShowScrollButton(false);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load session
  const loadSession = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data: ChatSessionDetailResponse = await getChatSession(projectId, sessionId);
      setSession(data.session);
      setMessages(data.messages);
      setHasMore(data.hasMore);
      if (data.session.task) setTaskEmbed(data.session.task);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => { void loadSession(); }, [loadSession]);

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
  const isWorkspaceRunning = workspace?.status === 'running';
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
    isWorkspaceRunning,
  );

  // Polling fallback
  useEffect(() => {
    if (!session || session.status !== 'active') return;

    const abortController = new AbortController();
    const ACTIVE_POLL_MS = 3000;
    let lastPollFingerprint = '';
    const pollInterval = setInterval(async () => {
      try {
        const data: ChatSessionDetailResponse = await getChatSession(
          projectId, sessionId, { signal: abortController.signal },
        );
        if (data.session.id !== sessionId) return;
        const newLastId = data.messages[data.messages.length - 1]?.id ?? '';
        const taskStatus = data.session.task?.status ?? '';
        const agentSessId = data.session.agentSessionId ?? '';
        const fingerprint = `${data.messages.length}:${newLastId}:${data.session.status}:${data.hasMore}:${taskStatus}:${agentSessId}`;
        if (fingerprint !== lastPollFingerprint) {
          lastPollFingerprint = fingerprint;
          setSession(data.session);
          setHasMore(data.hasMore);
          setMessages((prev) => mergeMessages(prev, data.messages, 'replace'));
          if (data.session.task) setTaskEmbed(data.session.task);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }, ACTIVE_POLL_MS);

    return () => {
      clearInterval(pollInterval);
      abortController.abort();
    };
  }, [session?.status, projectId, sessionId]);

  // Send follow-up
  const handleSendFollowUp = async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    setSendingFollowUp(true);
    try {
      if (sessionState === 'idle') {
        resetIdleTimer(projectId, sessionId)
          .then((result) => {
            if (result.cleanupAt) {
              setSession((prev) => {
                if (!prev) return prev;
                return { ...prev, cleanupAt: result.cleanupAt, isIdle: false, agentCompletedAt: null } as ChatSessionResponse;
              });
            }
          })
          .catch(() => {});
      }

      const optimisticId = `optimistic-${crypto.randomUUID()}`;
      setMessages((prev) => [...prev, {
        id: optimisticId,
        sessionId,
        role: 'user',
        content: trimmed,
        toolMetadata: null,
        createdAt: Date.now(),
      }]);

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'message.send',
          sessionId,
          content: trimmed,
          role: 'user',
        }));
      }

      if (agentSession.isAgentActive) {
        agentSession.sendPrompt(trimmed);
      } else if (recovery.isResuming) {
        recovery.pendingFollowUpRef.current = trimmed;
      } else if (sessionState === 'idle' && session?.workspaceId && agentSessionId) {
        recovery.hasAttemptedAutoResumeRef.current = true;
        recovery.pendingFollowUpRef.current = trimmed;
        recovery.setIsResuming(true);
        recovery.setResumeError(null);
        resumeAgentSession(session.workspaceId, agentSessionId)
          .then(() => {
            setSession((prev) => {
              if (!prev) return prev;
              return { ...prev, isIdle: false, agentCompletedAt: null } as ChatSessionResponse;
            });
            agentSession.reconnect();
          })
          .catch((err) => {
            recovery.setIsResuming(false);
            recovery.pendingFollowUpRef.current = null;
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')) {
              recovery.setResumeError('Could not resume agent \u2014 workspace may have been cleaned up.');
            } else {
              console.error('Agent resume failed:', msg);
              recovery.setResumeError('Could not resume agent \u2014 please try again.');
            }
          });
      } else {
        setError('Agent is not connected \u2014 message saved but prompt not delivered.');
      }

      setFollowUp('');
    } finally {
      setSendingFollowUp(false);
    }
  };

  // Upload files
  const handleUploadFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;
    setUploading(true);
    try {
      const result = await uploadSessionFiles(projectId, sessionId, fileArray);
      const names = result.files.map((f) => f.name).join(', ');
      setMessages((prev) => [...prev, {
        id: `optimistic-upload-${crypto.randomUUID()}`,
        sessionId,
        role: 'user' as const,
        content: `Uploaded ${result.files.length} file${result.files.length > 1 ? 's' : ''}: ${names}`,
        toolMetadata: null,
        createdAt: Date.now(),
      }]);
    } catch (err) {
      console.error('File upload failed:', err);
    } finally {
      setUploading(false);
    }
  }, [projectId, sessionId]);

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
    resumeError: recovery.resumeError,
    connectionState,
    showConnectionBanner: recovery.showConnectionBanner,
    retryWs,
    agentSession,
    acpGrace: recovery.acpGrace,
    committedToDoViewRef: recovery.committedToDoViewRef,
    firstItemIndex,
    showScrollButton,
    setShowScrollButton,
    idleCountdownMs: recovery.idleCountdownMs,
    filePanel,
    setFilePanel,
    handleFileClick,
    handleOpenFileBrowser,
    handleOpenGitChanges,
    handleSendFollowUp,
    handleUploadFiles,
    loadMore,
    loadingMore,
    transcribeApiUrl,
    wsRef,
  };
}
