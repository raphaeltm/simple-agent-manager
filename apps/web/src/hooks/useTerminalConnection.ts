import { useState, useEffect, useRef, useCallback } from 'react';
import { getTerminalToken } from '../lib/api';

interface UseTerminalConnectionOptions {
  workspaceId: string | undefined;
  workspaceUrl: string | undefined;
  isRunning: boolean;
  multiTerminal: boolean;
  terminalToken: string | null;
  terminalLoading: boolean;
}

/**
 * Manages the terminal WebSocket URL derivation and caching.
 *
 * Only updates wsUrl on the INITIAL token fetch or when the workspace URL
 * changes — NOT on proactive token refreshes. Changing wsUrl tears down
 * the WebSocket and triggers a full reconnect.
 */
export function useTerminalConnection({
  workspaceId,
  workspaceUrl,
  isRunning,
  multiTerminal,
  terminalToken,
  terminalLoading,
}: UseTerminalConnectionOptions) {
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const terminalWsUrlCacheRef = useRef<{ url: string; resolvedAt: number } | null>(null);
  const wsUrlSetRef = useRef(false);

  const buildTerminalWsUrl = useCallback(
    (token: string): string | null => {
      if (!workspaceUrl) return null;
      try {
        const url = new URL(workspaceUrl);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsPath = multiTerminal ? '/terminal/ws/multi' : '/terminal/ws';
        return `${wsProtocol}//${url.host}${wsPath}?token=${encodeURIComponent(token)}`;
      } catch {
        return null;
      }
    },
    [workspaceUrl, multiTerminal]
  );

  // Reset cache when workspace URL or settings change
  useEffect(() => {
    terminalWsUrlCacheRef.current = null;
  }, [workspaceUrl, workspaceId, multiTerminal]);

  const resolveTerminalWsUrl = useCallback(async (): Promise<string | null> => {
    if (!workspaceId) return null;

    const cached = terminalWsUrlCacheRef.current;
    if (cached && Date.now() - cached.resolvedAt < 15_000) {
      return cached.url;
    }

    const { token } = await getTerminalToken(workspaceId);
    const resolvedUrl = buildTerminalWsUrl(token);
    if (!resolvedUrl) {
      throw new Error('Invalid workspace URL');
    }
    terminalWsUrlCacheRef.current = { url: resolvedUrl, resolvedAt: Date.now() };
    return resolvedUrl;
  }, [workspaceId, buildTerminalWsUrl]);

  // Derive WebSocket URL from the terminal token.
  // Only update wsUrl on the INITIAL token fetch or when the workspace URL
  // changes — NOT on proactive token refreshes.
  useEffect(() => {
    if (!workspaceUrl || !terminalToken || !isRunning) {
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
  }, [workspaceUrl, terminalToken, isRunning, buildTerminalWsUrl]);

  const clearWsUrlCache = useCallback(() => {
    terminalWsUrlCacheRef.current = null;
  }, []);

  return {
    wsUrl,
    terminalError,
    terminalLoading,
    setTerminalError,
    resolveTerminalWsUrl,
    clearWsUrlCache,
  };
}
