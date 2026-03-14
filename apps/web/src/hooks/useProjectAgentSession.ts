/**
 * useProjectAgentSession — ACP WebSocket connection for project chat.
 *
 * Wraps useAcpSession + useAcpMessages to provide the same agent communication
 * layer used by workspace chat (ChatSession.tsx). This unifies both views onto
 * a single protocol path: ACP WebSocket → VM Agent Gateway → SessionHost.
 *
 * The hook is enabled when:
 * - workspaceId is available (workspace has been created and linked to session)
 * - The session is in an interactive state (active or idle)
 *
 * When disabled (no workspaceId, or session terminated), the hook stays
 * disconnected and returns inert handles. The project chat falls back to
 * DO-persisted messages for history display.
 */
import { useCallback, useEffect, useRef, useMemo } from 'react';
import { useAcpSession, useAcpMessages } from '@simple-agent-manager/acp-client';
import type { AcpLifecycleEvent } from '@simple-agent-manager/acp-client';
import { getTerminalToken, getTranscribeApiUrl } from '../lib/api';
import { reportError } from '../lib/error-reporter';

const API_URL = (() => {
  const url = import.meta.env.VITE_API_URL;
  if (!url && import.meta.env.PROD) {
    throw new Error('VITE_API_URL is required in production builds');
  }
  return url || 'http://localhost:8787';
})();

/** Derive the workspace WebSocket host from API_URL.
 *  api.example.com → ws-{id}.example.com
 */
/** Accept both UUIDs (8-4-4-4-12 hex) and ULIDs (26 Crockford Base32 chars) */
const VALID_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;

function deriveWorkspaceWsHost(workspaceId: string): string {
  if (!VALID_ID_RE.test(workspaceId)) {
    return '';
  }
  try {
    const apiUrl = new URL(API_URL);
    // Strip 'api.' prefix to get base domain
    const baseDomain = apiUrl.hostname.replace(/^api\./, '');
    const wsProtocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//ws-${workspaceId.toLowerCase()}.${baseDomain}`;
  } catch {
    return '';
  }
}

export interface UseProjectAgentSessionOptions {
  /** Workspace ID (available once workspace is created and linked to session) */
  workspaceId: string | null;
  /** Agent session ID from the workspace */
  sessionId: string;
  /** Whether the ACP connection should be active */
  enabled: boolean;
  /** Preferred agent type (e.g., 'claude-code') */
  preferredAgentType?: string;
}

export interface UseProjectAgentSessionReturn {
  /** The underlying ACP session handle */
  session: ReturnType<typeof useAcpSession>;
  /** The underlying ACP messages handle */
  messages: ReturnType<typeof useAcpMessages>;
  /** Whether the ACP WebSocket is connected and agent is ready or prompting */
  isAgentActive: boolean;
  /** Whether the agent is currently processing a prompt */
  isPrompting: boolean;
  /** Whether the ACP connection is being established */
  isConnecting: boolean;
  /** Send a prompt to the agent via ACP */
  sendPrompt: (text: string) => void;
  /** Cancel the current agent prompt via ACP */
  cancelPrompt: () => void;
  /** Transcription API URL for voice input */
  transcribeApiUrl: string;
}

export function useProjectAgentSession({
  workspaceId,
  sessionId,
  enabled,
  preferredAgentType,
}: UseProjectAgentSessionOptions): UseProjectAgentSessionReturn {
  // Stable transcription URL
  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  // Cache for resolved WebSocket URL (with token)
  const wsUrlCacheRef = useRef<{ url: string; resolvedAt: number } | null>(null);

  // Workspace host for WebSocket URL construction
  const wsHost = useMemo(
    () => (workspaceId ? deriveWorkspaceWsHost(workspaceId) : null),
    [workspaceId]
  );

  // Invalidate cache when key params change
  useEffect(() => {
    wsUrlCacheRef.current = null;
  }, [wsHost, workspaceId, sessionId]);

  // Lifecycle event handler — routes to error reporter + invalidates cache on errors
  const handleLifecycleEvent = useCallback(
    (event: AcpLifecycleEvent) => {
      if (
        event.context?.['state'] === 'error' ||
        event.context?.['state'] === 'reconnecting' ||
        event.message.includes('WebSocket closed') ||
        event.message.includes('WebSocket error')
      ) {
        wsUrlCacheRef.current = null;
      }
      reportError({
        level: event.level,
        message: event.message,
        source: event.source,
        context: {
          ...event.context,
          workspaceId: workspaceId ?? undefined,
          sessionId,
          component: 'project-chat',
        },
      });
    },
    [workspaceId, sessionId]
  );

  // Resolve ACP WebSocket URL with fresh token (cached for 15s)
  const resolveWsUrl = useCallback(async (): Promise<string | null> => {
    if (!wsHost || !workspaceId || !enabled) return null;

    const cached = wsUrlCacheRef.current;
    if (cached && Date.now() - cached.resolvedAt < 15_000) {
      return cached.url;
    }

    try {
      const { token } = await getTerminalToken(workspaceId);
      const sessionQuery = `&sessionId=${encodeURIComponent(sessionId)}`;
      const url = `${wsHost}/agent/ws?token=${encodeURIComponent(token)}${sessionQuery}`;
      wsUrlCacheRef.current = { url, resolvedAt: Date.now() };
      return url;
    } catch (err) {
      reportError({
        level: 'error',
        message: `Token fetch failed for project chat ACP: ${err instanceof Error ? err.message : String(err)}`,
        source: 'project-agent-session',
        context: { workspaceId, sessionId },
      });
      throw err;
    }
  }, [wsHost, workspaceId, sessionId, enabled]);

  // ACP message store — cleared on reconnect via onPrepareForReplay
  const acpMessages = useAcpMessages();

  // ACP session — separate WebSocket to VM Agent gateway.
  // wsUrl is set to wsHost (not null) so the connection effect re-fires when
  // the workspace changes (e.g., warm node reuse). The actual URL with token
  // is resolved dynamically via resolveWsUrl on each connect/reconnect.
  const acpSession = useAcpSession({
    wsUrl: enabled && wsHost ? wsHost : null,
    resolveWsUrl: enabled && wsHost ? resolveWsUrl : undefined,
    onAcpMessage: acpMessages.processMessage,
    onLifecycleEvent: handleLifecycleEvent,
    onPrepareForReplay: acpMessages.prepareForReplay,
  });

  const { connected, agentType, state, switchAgent } = acpSession;

  // Clear messages when entering no_session state (agent not yet selected)
  const { clear: clearMessages } = acpMessages;
  useEffect(() => {
    if (state === 'no_session') {
      clearMessages();
    }
  }, [state, clearMessages]);

  // Auto-select preferred agent when connected
  const hasAutoSelectedRef = useRef(false);

  // Reset auto-select flag when workspace changes
  useEffect(() => {
    hasAutoSelectedRef.current = false;
  }, [workspaceId]);

  useEffect(() => {
    if (!preferredAgentType || !connected) return;
    if (agentType === preferredAgentType) return;
    if (hasAutoSelectedRef.current && agentType) return;
    // Don't override a running agent — the task runner already started the
    // correct agent for this session. Auto-selecting a different agent would
    // kill the task-driven process (e.g., mistral-vibe killed by claude-code).
    if (agentType) return;
    if (
      state === 'connecting' ||
      state === 'reconnecting' ||
      state === 'initializing' ||
      state === 'replaying'
    )
      return;

    hasAutoSelectedRef.current = true;
    switchAgent(preferredAgentType);
  }, [preferredAgentType, connected, agentType, state, switchAgent]);

  // Derived state
  const isAgentActive = state === 'ready' || state === 'prompting';
  const isPrompting = state === 'prompting';
  const isConnecting =
    state === 'connecting' || state === 'initializing' || state === 'replaying';

  // Send prompt via ACP WebSocket
  const sendPrompt = useCallback(
    (text: string) => {
      if (!isAgentActive) return;
      acpMessages.addUserMessage(text);
      acpSession.sendMessage({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: Date.now(),
        params: {
          prompt: [{ type: 'text', text }],
        },
      });
    },
    [isAgentActive, acpMessages, acpSession]
  );

  // Cancel current prompt via ACP WebSocket
  const cancelPrompt = useCallback(() => {
    if (!isPrompting) return;
    acpSession.sendMessage({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: {},
    });
  }, [isPrompting, acpSession]);

  return {
    session: acpSession,
    messages: acpMessages,
    isAgentActive,
    isPrompting,
    isConnecting,
    sendPrompt,
    cancelPrompt,
    transcribeApiUrl,
  };
}
