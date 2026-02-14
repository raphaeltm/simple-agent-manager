import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAcpSession, useAcpMessages, AgentPanel } from '@simple-agent-manager/acp-client';
import type { ChatSettingsData } from '@simple-agent-manager/acp-client';
import type { AgentInfo } from '@simple-agent-manager/shared';
import { VALID_PERMISSION_MODES, AGENT_PERMISSION_MODE_LABELS } from '@simple-agent-manager/shared';
import { getTerminalToken, getTranscribeApiUrl, getAgentSettings, saveAgentSettings } from '../lib/api';

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

  // Each chat session gets its own message store (persisted in sessionStorage for reconnect recovery)
  const acpMessages = useAcpMessages({ sessionId });

  // Own ACP session hook — separate WebSocket per chat tab
  const acpSession = useAcpSession({
    wsUrl: resolvedWsUrl,
    onAcpMessage: acpMessages.processMessage,
  });

  // Clear message cache on reconnection so LoadSession replay doesn't duplicate.
  // When the WebSocket re-opens (state → 'no_session') after having been connected
  // before, the server will replay the full conversation via LoadSession. We clear
  // the local cache so the replay is the single source of truth.
  const { connected, agentType, state, switchAgent } = acpSession;
  const prevStateRef = useRef(state);
  useEffect(() => {
    const prevState = prevStateRef.current;
    prevStateRef.current = state;

    // Detect reconnection: previous state was reconnecting/error/disconnected,
    // and we just transitioned to 'no_session' (WebSocket opened successfully)
    if (
      state === 'no_session' &&
      (prevState === 'reconnecting' || prevState === 'error' || prevState === 'disconnected') &&
      acpMessages.items.length > 0
    ) {
      acpMessages.clear();
    }
  }, [state, acpMessages]);

  // Auto-select preferred agent when connected
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

  // ── Agent settings ──
  const [agentSettings, setAgentSettings] = useState<ChatSettingsData | null>(null);
  const [agentSettingsLoading, setAgentSettingsLoading] = useState(false);

  // Build permission mode options from shared constants
  const permissionModes = useMemo(
    () =>
      VALID_PERMISSION_MODES.map((mode) => ({
        value: mode,
        label: AGENT_PERMISSION_MODE_LABELS[mode] ?? mode,
      })),
    []
  );

  // Fetch settings when agent type is known
  const activeAgentType = agentType ?? preferredAgentId;
  useEffect(() => {
    if (!activeAgentType) return;
    let cancelled = false;
    setAgentSettingsLoading(true);

    getAgentSettings(activeAgentType)
      .then((result) => {
        if (cancelled) return;
        setAgentSettings({
          model: result.model,
          permissionMode: result.permissionMode,
        });
      })
      .catch(() => {
        if (cancelled) return;
        // No saved settings — use defaults
        setAgentSettings({ model: null, permissionMode: null });
      })
      .finally(() => {
        if (!cancelled) setAgentSettingsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeAgentType]);

  const handleSaveSettings = useCallback(
    async (data: { model?: string | null; permissionMode?: string | null }) => {
      if (!activeAgentType) return;
      const result = await saveAgentSettings(activeAgentType, {
        model: data.model,
        permissionMode: data.permissionMode as import('@simple-agent-manager/shared').AgentPermissionMode | null | undefined,
      });
      setAgentSettings({
        model: result.model,
        permissionMode: result.permissionMode,
      });
    },
    [activeAgentType]
  );

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
        agentSettings={agentSettings}
        agentSettingsLoading={agentSettingsLoading}
        permissionModes={permissionModes}
        onSaveSettings={handleSaveSettings}
      />
    </div>
  );
}
