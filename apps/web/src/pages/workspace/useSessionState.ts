import type { TokenUsage } from '@simple-agent-manager/acp-client';
import type { AgentInfo, AgentSession, AgentType } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NavigateFunction } from 'react-router';

import type { ChatSessionHandle } from '../../components/ChatSession';
import type { SessionTokenUsage } from '../../components/WorkspaceSidebar';
import {
  createAgentSession,
  listAgentSessions,
  listAgents,
  resumeAgentSession,
  stopAgentSession,
} from '../../lib/api';
import { isOrphanedSession, isSessionActive } from '../../lib/session-utils';

import type { ViewMode } from './types';

export interface UseSessionStateResult {
  sessionsLoading: boolean;
  agentOptions: AgentInfo[];
  configuredAgents: AgentInfo[];
  agentNameById: Map<string, string>;
  defaultAgentId: AgentType | null;
  defaultAgentName: string | null;
  preferredAgentsBySession: Record<string, AgentInfo['id']>;
  sessionTokenUsages: SessionTokenUsage[];
  recentlyStopped: Set<string>;
  dismissedOrphans: boolean;
  setDismissedOrphans: (v: boolean) => void;
  activeChatSessionId: string | null;
  runningChatSessions: AgentSession[];
  orphanedSessions: AgentSession[];
  historySessions: AgentSession[];
  handleCreateSession: (preferredAgentId?: AgentInfo['id']) => Promise<void>;
  handleStopSession: (sessionId: string) => Promise<void>;
  handleAttachSession: (sessionId: string) => void;
  handleResumeSession: (sessionId: string) => Promise<void>;
  handleDeleteHistorySession: (sessionId: string) => Promise<void>;
  handleUsageChange: (sessionId: string, usage: TokenUsage) => void;
  handleStopAllOrphans: () => Promise<void>;
}

export function useSessionState(
  id: string | undefined,
  navigate: NavigateFunction,
  searchParams: URLSearchParams,
  viewMode: ViewMode,
  setViewMode: (mode: ViewMode) => void,
  isRunning: boolean,
  agentSessions: AgentSession[],
  setAgentSessions: React.Dispatch<React.SetStateAction<AgentSession[]>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
  loadWorkspaceState: () => Promise<void>,
  activeWorktree: string | null,
  chatSessionRefs: React.RefObject<Map<string, ChatSessionHandle>>,
  tabOrderAssignOrder: (tabId: string) => void,
): UseSessionStateResult {
  const sessionIdParam = searchParams.get('sessionId');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [agentOptions, setAgentOptions] = useState<AgentInfo[]>([]);
  const [preferredAgentsBySession, setPreferredAgentsBySession] = useState<Record<string, AgentInfo['id']>>({});
  const [sessionTokenUsages, setSessionTokenUsages] = useState<SessionTokenUsage[]>([]);
  const [recentlyStopped, setRecentlyStopped] = useState<Set<string>>(new Set());
  const [dismissedOrphans, setDismissedOrphans] = useState(false);

  // Load agent options
  useEffect(() => {
    if (!isRunning) { setAgentOptions([]); return; }
    let cancelled = false;
    void (async () => {
      try {
        const data = await listAgents();
        if (!cancelled) setAgentOptions(data.agents || []);
      } catch { if (!cancelled) setAgentOptions([]); }
    })();
    return () => { cancelled = true; };
  }, [isRunning]);

  const configuredAgents = useMemo(
    () => agentOptions.filter((a) => a.configured && a.supportsAcp),
    [agentOptions]
  );
  const agentNameById = useMemo(
    () => new Map(configuredAgents.map((a) => [a.id, a.name])),
    [configuredAgents]
  );
  const defaultAgentId: AgentType | null = configuredAgents.length === 1 ? configuredAgents[0]!.id : null;
  const defaultAgentName = defaultAgentId ? (agentNameById.get(defaultAgentId) ?? null) : null;

  const activeChatSessionId = viewMode === 'conversation'
    ? sessionIdParam || agentSessions.find((s) => isSessionActive(s) && !recentlyStopped.has(s.id))?.id || null
    : null;

  // Derived session lists
  const runningChatSessions = useMemo(
    () => agentSessions.filter((s) => isSessionActive(s) && !recentlyStopped.has(s.id)),
    [agentSessions, recentlyStopped]
  );
  const orphanedSessions = useMemo(
    () => agentSessions.filter((s) => isOrphanedSession(s) && !recentlyStopped.has(s.id)),
    [agentSessions, recentlyStopped]
  );
  const historySessions = useMemo(
    () => agentSessions
      .filter((s) => s.status === 'stopped' && !recentlyStopped.has(s.id))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [agentSessions, recentlyStopped]
  );

  // Token usage
  const handleUsageChange = useCallback(
    (sessionId: string, usage: TokenUsage) => {
      setSessionTokenUsages((prev) => {
        const idx = prev.findIndex((s) => s.sessionId === sessionId);
        const session = agentSessions.find((s) => s.id === sessionId);
        const label = session?.label ?? `Chat ${sessionId.slice(-4)}`;
        const entry: SessionTokenUsage = { sessionId, label, usage };
        if (idx >= 0) { const next = [...prev]; next[idx] = entry; return next; }
        return [...prev, entry];
      });
    },
    [agentSessions]
  );

  // Session CRUD
  const handleAttachSession = (sessionId: string) => {
    if (!id) return;
    const params = new URLSearchParams(searchParams);
    params.set('view', 'conversation');
    params.set('sessionId', sessionId);
    navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
    setViewMode('conversation');
  };

  const handleCreateSession = async (preferredAgentId?: AgentInfo['id']) => {
    if (!id) return;
    try {
      setSessionsLoading(true);
      const preferredAgent = preferredAgentId ? configuredAgents.find((a) => a.id === preferredAgentId) : undefined;
      const runningCount = agentSessions.filter((s) => s.status === 'running').length;
      const label = preferredAgent ? `${preferredAgent.name} ${runningCount + 1}` : `Chat ${runningCount + 1}`;
      const created = await createAgentSession(id, {
        label, agentType: preferredAgentId, worktreePath: activeWorktree ?? undefined,
      });
      setAgentSessions((prev) => [...prev.filter((s) => s.id !== created.id), created]);
      tabOrderAssignOrder(`chat:${created.id}`);
      if (preferredAgentId) setPreferredAgentsBySession((prev) => ({ ...prev, [created.id]: preferredAgentId }));
      const params = new URLSearchParams(searchParams);
      params.set('view', 'conversation');
      params.set('sessionId', created.id);
      navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
      setViewMode('conversation');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleStopSession = async (sessionId: string) => {
    if (!id) return;
    try {
      setSessionsLoading(true);
      await stopAgentSession(id, sessionId);
      const sessions = await listAgentSessions(id);
      setAgentSessions(sessions);
      chatSessionRefs.current.delete(sessionId);
      setPreferredAgentsBySession((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev }; delete next[sessionId]; return next;
      });
      setSessionTokenUsages((prev) => prev.filter((s) => s.sessionId !== sessionId));
      if (sessionIdParam === sessionId) {
        const params = new URLSearchParams(searchParams);
        params.set('view', 'terminal');
        params.delete('sessionId');
        navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
        setViewMode('terminal');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop session');
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleResumeSession = async (sessionId: string) => {
    if (!id) return;
    try {
      setSessionsLoading(true);
      await resumeAgentSession(id, sessionId);
      const sessions = await listAgentSessions(id);
      setAgentSessions(sessions);
      handleAttachSession(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume session');
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleDeleteHistorySession = async (sessionId: string) => {
    if (!id) return;
    try {
      setSessionsLoading(true);
      await stopAgentSession(id, sessionId);
      setAgentSessions(await listAgentSessions(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session');
    } finally {
      setSessionsLoading(false);
    }
  };

  // Orphan management
  useEffect(() => {
    if (!id || orphanedSessions.length === 0) return;
    for (const session of orphanedSessions) {
      void resumeAgentSession(id, session.id).catch(() => {});
    }
  }, [id, orphanedSessions]);

  const handleStopAllOrphans = useCallback(async () => {
    if (!id) return;
    const orphanIds = orphanedSessions.map((s) => s.id);
    setRecentlyStopped((prev) => new Set([...prev, ...orphanIds]));
    for (const session of orphanedSessions) {
      try { await stopAgentSession(id, session.id); } catch {}
    }
    void loadWorkspaceState();
    setTimeout(() => {
      setRecentlyStopped((prev) => {
        const next = new Set(prev);
        for (const oid of orphanIds) next.delete(oid);
        return next;
      });
    }, 10_000);
  }, [id, orphanedSessions, loadWorkspaceState]);

  useEffect(() => {
    if (orphanedSessions.length === 0) setDismissedOrphans(false);
  }, [orphanedSessions.length]);

  return {
    sessionsLoading,
    agentOptions,
    configuredAgents,
    agentNameById,
    defaultAgentId,
    defaultAgentName,
    preferredAgentsBySession,
    sessionTokenUsages,
    recentlyStopped,
    dismissedOrphans,
    setDismissedOrphans,
    activeChatSessionId,
    runningChatSessions,
    orphanedSessions,
    historySessions,
    handleCreateSession,
    handleStopSession,
    handleAttachSession,
    handleResumeSession,
    handleDeleteHistorySession,
    handleUsageChange,
    handleStopAllOrphans,
  };
}
