import type {
  AgentSession,
  DetectedPort,
  Event,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useBootLogStream } from '../../hooks/useBootLogStream';
import { useTokenRefresh } from '../../hooks/useTokenRefresh';
import { useWorkspacePorts } from '../../hooks/useWorkspacePorts';
import {
  getTerminalToken,
  getWorkspace,
  listAgentSessions,
  listAgentSessionsLive,
  listWorkspaceEvents,
  rebuildWorkspace,
  restartWorkspace,
  stopWorkspace,
  updateWorkspace,
} from '../../lib/api';

export interface UseWorkspaceCoreResult {
  workspace: WorkspaceResponse | null;
  loading: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  actionLoading: boolean;
  wsUrl: string | null;
  terminalError: string | null;
  terminalToken: string | null;
  terminalLoading: boolean;
  displayNameInput: string;
  setDisplayNameInput: React.Dispatch<React.SetStateAction<string>>;
  renaming: boolean;
  workspaceEvents: Event[];
  isRunning: boolean;
  streamedBootLogs: import('@simple-agent-manager/shared').BootLogEntry[];
  detectedPorts: DetectedPort[];
  agentSessions: AgentSession[];
  setAgentSessions: React.Dispatch<React.SetStateAction<AgentSession[]>>;
  loadWorkspaceState: () => Promise<void>;
  resolveTerminalWsUrl: () => Promise<string | null>;
  refreshTerminalToken: () => Promise<void>;
  handleStop: () => Promise<void>;
  handleRestart: () => Promise<void>;
  handleRebuild: () => Promise<void>;
  handleRename: () => Promise<void>;
  buildTerminalWsUrl: (token: string) => string | null;
  terminalWsUrlCacheRef: React.RefObject<{ url: string; resolvedAt: number } | null>;
}

export function useWorkspaceCore(
  id: string | undefined,
  multiTerminalEnabled: boolean
): UseWorkspaceCoreResult {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [workspaceEvents, setWorkspaceEvents] = useState<Event[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);

  const terminalWsUrlCacheRef = useRef<{ url: string; resolvedAt: number } | null>(null);
  const wsUrlSetRef = useRef(false);

  const isRunning = workspace?.status === 'running' || workspace?.status === 'recovery';

  // Proactive token refresh
  const tokenRefreshFetchToken = useCallback(async () => {
    if (!id) throw new Error('No workspace ID');
    return getTerminalToken(id);
  }, [id]);

  const {
    token: terminalToken,
    loading: terminalLoading,
    error: tokenRefreshError,
    refresh: refreshTerminalToken,
  } = useTokenRefresh({
    fetchToken: tokenRefreshFetchToken,
    enabled: isRunning && !!id,
  });

  // Propagate token refresh errors
  useEffect(() => {
    if (tokenRefreshError) {
      setTerminalError(tokenRefreshError);
    }
  }, [tokenRefreshError]);

  // Boot log streaming
  const { logs: streamedBootLogs } = useBootLogStream(
    id,
    workspace?.url,
    workspace?.status
  );

  // Load workspace state
  const loadWorkspaceState = useCallback(async () => {
    if (!id) return;

    try {
      setError(null);
      const workspaceData = await getWorkspace(id);
      setWorkspace(workspaceData);
      setDisplayNameInput(workspaceData.displayName || workspaceData.name);

      const wsRunning =
        workspaceData.status === 'running' || workspaceData.status === 'recovery';
      let sessionsData: AgentSession[] = [];
      if (wsRunning && workspaceData.url && terminalToken) {
        try {
          const [liveSessions, cpSessions] = await Promise.all([
            listAgentSessionsLive(workspaceData.url, id, terminalToken),
            listAgentSessions(id).catch(() => [] as AgentSession[]),
          ]);
          const cpMap = new Map(cpSessions.map((s) => [s.id, s]));
          sessionsData = liveSessions.map((s) => ({
            ...s,
            agentType: s.agentType ?? cpMap.get(s.id)?.agentType ?? null,
          }));
        } catch {
          sessionsData = await listAgentSessions(id);
        }
      } else {
        sessionsData = await listAgentSessions(id);
      }
      setAgentSessions(sessionsData || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, [id, terminalToken]);

  // Load/reload workspace
  useEffect(() => {
    if (!id) return;

    void loadWorkspaceState();

    const interval = setInterval(() => {
      if (
        workspace?.status === 'creating' ||
        workspace?.status === 'stopping' ||
        workspace?.status === 'running' ||
        workspace?.status === 'recovery'
      ) {
        void loadWorkspaceState();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [id, workspace?.status, loadWorkspaceState]);

  // Build terminal WebSocket URL
  const buildTerminalWsUrl = useCallback(
    (token: string): string | null => {
      if (!workspace?.url) return null;
      try {
        const url = new URL(workspace.url);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsPath = multiTerminalEnabled ? '/terminal/ws/multi' : '/terminal/ws';
        return `${wsProtocol}//${url.host}${wsPath}?token=${encodeURIComponent(token)}`;
      } catch {
        return null;
      }
    },
    [workspace?.url, multiTerminalEnabled]
  );

  // Clear cache when URL changes
  useEffect(() => {
    terminalWsUrlCacheRef.current = null;
  }, [workspace?.url, id, multiTerminalEnabled]);

  // Resolve terminal WS URL (cached)
  const resolveTerminalWsUrl = useCallback(async (): Promise<string | null> => {
    if (!id) return null;

    const cached = terminalWsUrlCacheRef.current;
    if (cached && Date.now() - cached.resolvedAt < 15_000) {
      return cached.url;
    }

    const { token } = await getTerminalToken(id);
    const resolvedUrl = buildTerminalWsUrl(token);
    if (!resolvedUrl) {
      throw new Error('Invalid workspace URL');
    }
    terminalWsUrlCacheRef.current = { url: resolvedUrl, resolvedAt: Date.now() };
    return resolvedUrl;
  }, [id, buildTerminalWsUrl]);

  // Derive WebSocket URL from token (initial set only)
  useEffect(() => {
    if (!workspace?.url || !terminalToken || !isRunning) {
      setWsUrl(null);
      wsUrlSetRef.current = false;
      return;
    }

    if (wsUrlSetRef.current) return;

    const nextUrl = buildTerminalWsUrl(terminalToken);
    if (!nextUrl) {
      setWsUrl(null);
      setTerminalError('Invalid workspace URL');
      return;
    }

    setWsUrl(nextUrl);
    terminalWsUrlCacheRef.current = { url: nextUrl, resolvedAt: Date.now() };
    setTerminalError(null);
    wsUrlSetRef.current = true;
  }, [workspace?.url, terminalToken, isRunning, buildTerminalWsUrl]);

  // Poll detected ports
  const { ports: detectedPorts } = useWorkspacePorts(
    workspace?.url ?? undefined,
    id,
    terminalToken ?? undefined,
    isRunning
  );

  // Fetch workspace events from VM Agent
  useEffect(() => {
    if (!id || !workspace?.url || !terminalToken || !isRunning) return;

    const fetchEvents = async () => {
      try {
        const data = await listWorkspaceEvents(workspace.url!, id, terminalToken, 50);
        setWorkspaceEvents(data.events || []);
      } catch {
        // Events are secondary — polling retries
      }
    };

    void fetchEvents();
    const interval = setInterval(() => void fetchEvents(), 10000);
    return () => clearInterval(interval);
  }, [id, workspace?.url, isRunning, terminalToken]);

  // Workspace actions
  const handleStop = async () => {
    if (!id) return;
    try {
      setActionLoading(true);
      await stopWorkspace(id);
      setWorkspace((prev) => (prev ? { ...prev, status: 'stopping' } : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestart = async () => {
    if (!id) return;
    try {
      setActionLoading(true);
      await restartWorkspace(id);
      setWorkspace((prev) => (prev ? { ...prev, status: 'creating', errorMessage: null, bootLogs: [] } : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRebuild = async () => {
    if (!id) return;
    const confirmed = window.confirm(
      'This will rebuild the devcontainer from scratch. Any unsaved terminal state will be lost. Continue?'
    );
    if (!confirmed) return;
    try {
      setActionLoading(true);
      await rebuildWorkspace(id);
      setWorkspace((prev) => (prev ? { ...prev, status: 'creating', errorMessage: null, bootLogs: [] } : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rebuild workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRename = async () => {
    if (!id || !displayNameInput.trim()) return;
    try {
      setRenaming(true);
      const updated = await updateWorkspace(id, { displayName: displayNameInput.trim() });
      setWorkspace(updated);
      setDisplayNameInput(updated.displayName || updated.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename workspace');
    } finally {
      setRenaming(false);
    }
  };

  return {
    workspace,
    loading,
    error,
    setError,
    actionLoading,
    wsUrl,
    terminalError,
    terminalToken,
    terminalLoading,
    displayNameInput,
    setDisplayNameInput,
    renaming,
    workspaceEvents,
    isRunning,
    streamedBootLogs,
    detectedPorts,
    agentSessions,
    setAgentSessions,
    loadWorkspaceState,
    resolveTerminalWsUrl,
    refreshTerminalToken,
    handleStop,
    handleRestart,
    handleRebuild,
    handleRename,
    buildTerminalWsUrl,
    terminalWsUrlCacheRef,
  };
}
