import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAcpSession, useAcpMessages, AgentPanel } from '@simple-agent-manager/acp-client';
import type { AgentInfo } from '@simple-agent-manager/shared';
import { getTerminalToken, getTranscribeApiUrl } from '../lib/api';

interface ChatSessionProps {
  /** Workspace ID for token fetching */
  workspaceId: string;
  /** Workspace URL (e.g., https://ws-xxx.domain) */
  workspaceUrl: string;
  /** Agent session ID */
  sessionId: string;
  /** Preferred agent type for this session */
  preferredAgentId?: string;
  /** All configured agents */
  configuredAgents: AgentInfo[];
  /** Whether this tab is currently visible */
  active: boolean;
  /** Called on any activity (for idle detection) */
  onActivity?: () => void;
}

/**
 * Self-contained chat session component.
 * Each instance owns its own ACP WebSocket connection, message history,
 * and agent selection — fully independent of other chat tabs.
 */
export function ChatSession({
  workspaceId,
  workspaceUrl,
  sessionId,
  preferredAgentId,
  active,
  onActivity,
}: ChatSessionProps) {
  const [resolvedWsUrl, setResolvedWsUrl] = useState<string | null>(null);

  // Resolve transcription API URL once (stable across renders)
  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  // Parse workspace URL once
  const wsHostInfo = useMemo(() => {
    if (!workspaceUrl) return null;
    try {
      const url = new URL(workspaceUrl);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProtocol}//${url.host}`;
    } catch {
      return null;
    }
  }, [workspaceUrl]);

  // Fetch token and build full WS URL
  useEffect(() => {
    if (!wsHostInfo) {
      setResolvedWsUrl(null);
      return;
    }

    let cancelled = false;

    const fetchToken = async () => {
      try {
        const { token } = await getTerminalToken(workspaceId);
        if (cancelled) return;
        const sessionQuery = `&sessionId=${encodeURIComponent(sessionId)}`;
        const takeoverQuery = '&takeover=1';
        setResolvedWsUrl(
          `${wsHostInfo}/agent/ws?token=${encodeURIComponent(token)}${sessionQuery}${takeoverQuery}`
        );
      } catch {
        // Will retry on next render cycle or user action
      }
    };

    void fetchToken();
    return () => {
      cancelled = true;
    };
  }, [wsHostInfo, workspaceId, sessionId]);

  // Each chat session gets its own message store
  const acpMessages = useAcpMessages();

  // Own ACP session hook — separate WebSocket per chat tab
  const acpSession = useAcpSession({
    wsUrl: resolvedWsUrl,
    onAcpMessage: acpMessages.processMessage,
  });

  // Auto-select preferred agent when connected
  const { connected, agentType, state, switchAgent } = acpSession;
  useEffect(() => {
    if (!preferredAgentId) return;
    if (!connected) return;
    if (agentType === preferredAgentId) return;
    if (state === 'connecting' || state === 'reconnecting' || state === 'initializing') return;

    switchAgent(preferredAgentId);
  }, [preferredAgentId, connected, agentType, state, switchAgent]);

  // Report activity
  const handleActivity = useCallback(() => {
    onActivity?.();
  }, [onActivity]);

  useEffect(() => {
    if (acpMessages.items.length > 0) {
      handleActivity();
    }
  }, [acpMessages.items.length, handleActivity]);

  return (
    <div
      style={{
        height: '100%',
        overflow: 'hidden',
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
      }}
    >
      <AgentPanel
        session={acpSession}
        messages={acpMessages}
        availableCommands={acpMessages.availableCommands}
        transcribeApiUrl={transcribeApiUrl}
      />
    </div>
  );
}
