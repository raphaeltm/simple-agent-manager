import React, { useState, useEffect, useMemo, useCallback, useRef, useImperativeHandle } from 'react';
import { useAcpSession, useAcpMessages, AgentPanel } from '@simple-agent-manager/acp-client';
import type { AgentPanelHandle, ChatSettingsData, AcpLifecycleEvent } from '@simple-agent-manager/acp-client';
import type { AgentInfo } from '@simple-agent-manager/shared';
import { VALID_PERMISSION_MODES, AGENT_PERMISSION_MODE_LABELS } from '@simple-agent-manager/shared';
import { getTerminalToken, getTranscribeApiUrl, getAgentSettings, saveAgentSettings } from '../lib/api';
import { reportError } from '../lib/error-reporter';

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

/** Imperative handle for ChatSession — mirrors AgentPanelHandle. */
export type ChatSessionHandle = AgentPanelHandle;

/**
 * Self-contained chat session component.
 * Each instance owns its own ACP WebSocket connection, message history,
 * and agent selection — fully independent of other chat tabs.
 */
export const ChatSession = React.forwardRef<ChatSessionHandle, ChatSessionProps>(function ChatSession({
  workspaceId,
  workspaceUrl,
  sessionId,
  preferredAgentId,
  active,
  onActivity,
}, ref) {
  const agentPanelRef = useRef<AgentPanelHandle>(null);

  useImperativeHandle(ref, () => ({
    focusInput: () => agentPanelRef.current?.focusInput(),
  }));
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

  // Lifecycle event callback — routes ACP lifecycle events to the error reporter
  // for CF Workers observability. Enriches with workspaceId/sessionId context.
  const handleLifecycleEvent = useCallback(
    (event: AcpLifecycleEvent) => {
      reportError({
        level: event.level,
        message: event.message,
        source: event.source,
        context: {
          ...event.context,
          workspaceId,
          sessionId,
        },
      });
    },
    [workspaceId, sessionId]
  );

  // Fetch token and build full WS URL
  useEffect(() => {
    if (!wsHostInfo) {
      setResolvedWsUrl(null);
      return;
    }

    let cancelled = false;

    const fetchToken = async () => {
      reportError({
        level: 'info',
        message: 'Fetching terminal token',
        source: 'acp-chat',
        context: { workspaceId, sessionId },
      });

      try {
        const { token } = await getTerminalToken(workspaceId);
        if (cancelled) return;

        reportError({
          level: 'info',
          message: 'Terminal token fetched',
          source: 'acp-chat',
          context: { workspaceId, sessionId, tokenLength: token.length },
        });

        const sessionQuery = `&sessionId=${encodeURIComponent(sessionId)}`;
        setResolvedWsUrl(
          `${wsHostInfo}/agent/ws?token=${encodeURIComponent(token)}${sessionQuery}`
        );
      } catch (err) {
        if (cancelled) return;
        reportError({
          level: 'error',
          message: `Terminal token fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          source: 'acp-chat',
          context: { workspaceId, sessionId },
        });
      }
    };

    void fetchToken();
    return () => {
      cancelled = true;
    };
  }, [wsHostInfo, workspaceId, sessionId]);

  // Each chat session gets its own message store.
  // No client-side persistence — on reconnect, LoadSession replays the full
  // conversation from the agent via session/update notifications.
  const acpMessages = useAcpMessages();

  // Own ACP session hook — separate WebSocket per chat tab
  const acpSession = useAcpSession({
    wsUrl: resolvedWsUrl,
    onAcpMessage: acpMessages.processMessage,
    onLifecycleEvent: handleLifecycleEvent,
  });

  const { connected, agentType, state, switchAgent, replaying } = acpSession;
  const { clear: clearMessages } = acpMessages;

  // Clear messages when we start receiving a replay from the server.
  // The SessionHost sends session_state with replayCount > 0, which puts
  // us into 'replaying' state. Clear before the replayed messages arrive
  // to avoid duplicates. Also clear on 'no_session' (idle SessionHost).
  useEffect(() => {
    if (state === 'replaying' || state === 'no_session') {
      reportError({
        level: 'info',
        message: `Clearing messages on ${state} (pre-replay)`,
        source: 'acp-chat',
        context: { workspaceId, sessionId, replaying },
      });
      clearMessages();
    }
  }, [state, clearMessages, workspaceId, sessionId, replaying]);

  // Auto-select preferred agent when connected.
  // Skip if the server's session_state already indicates the agent is running
  // (e.g., reconnecting to a session where the agent kept working).
  useEffect(() => {
    if (!preferredAgentId) return;
    if (!connected) return;
    if (agentType === preferredAgentId) return;
    // Don't send select_agent while still connecting, reconnecting, initializing,
    // or replaying buffered messages from a running session.
    if (state === 'connecting' || state === 'reconnecting' || state === 'initializing' || state === 'replaying') return;

    reportError({
      level: 'info',
      message: `Auto-selecting agent: ${preferredAgentId}`,
      source: 'acp-chat',
      context: { workspaceId, sessionId, preferredAgentId, currentAgentType: agentType, state },
    });
    switchAgent(preferredAgentId);
  }, [preferredAgentId, connected, agentType, state, switchAgent, workspaceId, sessionId]);

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

  const handleError = useCallback(
    (info: { message: string; source: string; context?: Record<string, unknown> }) => {
      reportError({
        level: 'error',
        message: info.message,
        source: info.source,
        context: info.context,
      });
    },
    []
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
        ref={agentPanelRef}
        session={acpSession}
        messages={acpMessages}
        availableCommands={acpMessages.availableCommands}
        transcribeApiUrl={transcribeApiUrl}
        agentSettings={agentSettings}
        agentSettingsLoading={agentSettingsLoading}
        permissionModes={permissionModes}
        onSaveSettings={handleSaveSettings}
        onError={handleError}
      />
    </div>
  );
});
