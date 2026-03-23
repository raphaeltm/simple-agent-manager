import { useState, useEffect, useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { AgentInfo, AgentSession } from '@simple-agent-manager/shared';
import {
  createAgentSession,
  listAgents,
  listAgentSessions,
  resumeAgentSession,
  stopAgentSession,
} from '../lib/api';
import { isSessionActive, isOrphanedSession } from '../lib/session-utils';
import type { NavigateFunction } from 'react-router-dom';

interface UseWorkspaceSessionsOptions {
  workspaceId: string | undefined;
  isRunning: boolean;
  activeWorktree: string | null;
  searchParams: URLSearchParams;
  navigate: NavigateFunction;
  sessionIdParam: string | null;
  tabOrderAssign: (tabId: string) => void;
  /** External agentSessions state — owned by parent to avoid circular deps. */
  agentSessions: AgentSession[];
  setAgentSessions: Dispatch<SetStateAction<AgentSession[]>>;
  loadWorkspaceState: () => Promise<void>;
}

export function useWorkspaceSessions({
  workspaceId,
  isRunning,
  activeWorktree,
  searchParams,
  navigate,
  sessionIdParam,
  tabOrderAssign,
  agentSessions,
  setAgentSessions,
  loadWorkspaceState,
}: UseWorkspaceSessionsOptions) {
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [agentOptions, setAgentOptions] = useState<AgentInfo[]>([]);
  const [preferredAgentsBySession, setPreferredAgentsBySession] = useState<
    Record<string, AgentInfo['id']>
  >({});
  const [recentlyStopped, setRecentlyStopped] = useState<Set<string>>(new Set());
  const [dismissedOrphans, setDismissedOrphans] = useState(false);

  // Load agent options when running
  useEffect(() => {
    if (!isRunning) { setAgentOptions([]); return; }
    let cancelled = false;
    void (async () => {
      try {
        const data = await listAgents();
        if (!cancelled) setAgentOptions(data.agents || []);
      } catch {
        if (!cancelled) setAgentOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [isRunning]);

  const configuredAgents = useMemo(
    () => agentOptions.filter((agent) => agent.configured && agent.supportsAcp),
    [agentOptions]
  );

  const agentNameById = useMemo(
    () => new Map(configuredAgents.map((agent) => [agent.id, agent.name])),
    [configuredAgents]
  );

  const defaultAgentId = configuredAgents.length === 1 ? configuredAgents[0]!.id : null;
  const defaultAgentName = defaultAgentId ? (agentNameById.get(defaultAgentId) ?? null) : null;

  // ── Session CRUD ──

  const handleCreateSession = async (
    preferredAgentId: AgentInfo['id'] | undefined,
    setViewMode: (mode: 'conversation') => void
  ) => {
    if (!workspaceId) return;
    try {
      setSessionsLoading(true);
      const preferredAgent = preferredAgentId
        ? configuredAgents.find((agent) => agent.id === preferredAgentId)
        : undefined;
      const runningCount = agentSessions.filter((s) => s.status === 'running').length;
      const nextNumber = runningCount + 1;
      const label = preferredAgent
        ? `${preferredAgent.name} ${nextNumber}`
        : `Chat ${nextNumber}`;
      const created = await createAgentSession(workspaceId, {
        label,
        agentType: preferredAgentId,
        worktreePath: activeWorktree ?? undefined,
      });
      setAgentSessions((prev) => {
        const remaining = prev.filter((session) => session.id !== created.id);
        return [...remaining, created];
      });
      tabOrderAssign(`chat:${created.id}`);
      if (preferredAgentId) {
        setPreferredAgentsBySession((prev) => ({ ...prev, [created.id]: preferredAgentId }));
      }
      const params = new URLSearchParams(searchParams);
      params.set('view', 'conversation');
      params.set('sessionId', created.id);
      navigate(`/workspaces/${workspaceId}?${params.toString()}`, { replace: true });
      setViewMode('conversation');
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleStopSession = async (sessionId: string) => {
    if (!workspaceId) return;
    try {
      setSessionsLoading(true);
      await stopAgentSession(workspaceId, sessionId);
      const sessions = await listAgentSessions(workspaceId);
      setAgentSessions(sessions);
      setPreferredAgentsBySession((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      return { stopped: true, wasActive: sessionIdParam === sessionId };
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleResumeSession = async (sessionId: string) => {
    if (!workspaceId) return;
    try {
      setSessionsLoading(true);
      await resumeAgentSession(workspaceId, sessionId);
      const sessions = await listAgentSessions(workspaceId);
      setAgentSessions(sessions);
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleDeleteHistorySession = async (sessionId: string) => {
    if (!workspaceId) return;
    try {
      setSessionsLoading(true);
      await stopAgentSession(workspaceId, sessionId);
      const sessions = await listAgentSessions(workspaceId);
      setAgentSessions(sessions);
    } finally {
      setSessionsLoading(false);
    }
  };

  // ── Session lists ──

  const runningChatSessions = useMemo(
    () => agentSessions.filter((s) => isSessionActive(s) && !recentlyStopped.has(s.id)),
    [agentSessions, recentlyStopped]
  );

  const orphanedSessions = useMemo(
    () => agentSessions.filter((s) => isOrphanedSession(s) && !recentlyStopped.has(s.id)),
    [agentSessions, recentlyStopped]
  );

  const historySessions = useMemo(
    () =>
      agentSessions
        .filter((s) => s.status === 'stopped' && !recentlyStopped.has(s.id))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [agentSessions, recentlyStopped]
  );

  // Auto-resume orphans
  useEffect(() => {
    if (!workspaceId || orphanedSessions.length === 0) return;
    for (const session of orphanedSessions) {
      void resumeAgentSession(workspaceId, session.id).catch(() => {});
    }
  }, [workspaceId, orphanedSessions]);

  const handleStopAllOrphans = useCallback(async () => {
    if (!workspaceId) return;
    const orphanIds = orphanedSessions.map((s) => s.id);
    setRecentlyStopped((prev) => new Set([...prev, ...orphanIds]));
    for (const session of orphanedSessions) {
      try { await stopAgentSession(workspaceId, session.id); } catch { /* best effort */ }
    }
    void loadWorkspaceState();
    setTimeout(() => {
      setRecentlyStopped((prev) => {
        const next = new Set(prev);
        for (const oid of orphanIds) next.delete(oid);
        return next;
      });
    }, 10_000);
  }, [workspaceId, orphanedSessions, loadWorkspaceState]);

  useEffect(() => {
    if (orphanedSessions.length === 0) setDismissedOrphans(false);
  }, [orphanedSessions.length]);

  return {
    sessionsLoading,
    configuredAgents,
    agentNameById,
    defaultAgentId,
    defaultAgentName,
    preferredAgentsBySession,
    setPreferredAgentsBySession,
    recentlyStopped,
    dismissedOrphans,
    setDismissedOrphans,
    handleCreateSession,
    handleStopSession,
    handleResumeSession,
    handleDeleteHistorySession,
    runningChatSessions,
    orphanedSessions,
    historySessions,
    handleStopAllOrphans,
  };
}
