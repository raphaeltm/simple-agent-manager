/**
 * useConnectionRecovery — DO-only connection recovery for project chat.
 *
 * With the ACP WebSocket removed, this hook handles:
 * - Connection banner debounce (hide brief DO WebSocket blips)
 * - Idle timer countdown
 * - Resume state management (auto-resume idle sessions via REST API)
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import type { ChatSessionResponse } from '../../lib/api';
import { resumeAgentSession, sendFollowUpPrompt } from '../../lib/api';
import type { SessionState } from './types';
import {
  AUTO_RESUME_DELAY_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  RECONNECT_BANNER_DELAY_MS,
} from './types';

export interface UseConnectionRecoveryOptions {
  sessionId: string;
  projectId: string;
  sessionState: SessionState;
  connectionState: ChatConnectionState;
  session: ChatSessionResponse | null;
  isProvisioning: boolean;
  setSession: React.Dispatch<React.SetStateAction<ChatSessionResponse | null>>;
}

export interface UseConnectionRecoveryResult {
  isResuming: boolean;
  resumeError: string | null;
  showConnectionBanner: boolean;
  idleCountdownMs: number | null;
  /** Resume an idle session and optionally send a follow-up prompt. */
  resumeAndSend: (followUpText?: string) => void;
}

export function useConnectionRecovery(opts: UseConnectionRecoveryOptions): UseConnectionRecoveryResult {
  const {
    sessionId,
    projectId,
    sessionState,
    connectionState,
    session,
    isProvisioning,
    setSession,
  } = opts;

  // Resume state
  const [isResuming, setIsResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const hasAttemptedAutoResumeRef = useRef(false);

  // Connection banner debounce
  const [showConnectionBanner, setShowConnectionBanner] = useState(false);

  // Idle timer
  const [idleCountdownMs, setIdleCountdownMs] = useState<number | null>(null);

  // Reset state when switching sessions
  useEffect(() => {
    setIsResuming(false);
    setResumeError(null);
    hasAttemptedAutoResumeRef.current = false;
    setShowConnectionBanner(false);
  }, [sessionId]);

  // Idle timer countdown
  const cleanupAt = session?.cleanupAt ?? null;
  const agentCompletedAt = session?.agentCompletedAt ?? null;

  useEffect(() => {
    if (sessionState !== 'idle' || isResuming) {
      setIdleCountdownMs(null);
      return;
    }
    if (cleanupAt) {
      const tick = () => setIdleCountdownMs(Math.max(0, cleanupAt - Date.now()));
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    } else if (agentCompletedAt) {
      const estimatedCleanup = agentCompletedAt + DEFAULT_IDLE_TIMEOUT_MS;
      const tick = () => setIdleCountdownMs(Math.max(0, estimatedCleanup - Date.now()));
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    }
    return;
  }, [sessionState, cleanupAt, agentCompletedAt, isResuming]);

  // Auto-resume for idle sessions (one attempt only)
  const agentSessionId = session?.agentSessionId ?? null;
  useEffect(() => {
    if (
      sessionState !== 'idle' ||
      isResuming ||
      isProvisioning ||
      !session?.workspaceId ||
      !agentSessionId ||
      hasAttemptedAutoResumeRef.current
    ) return;

    const timer = setTimeout(() => {
      if (hasAttemptedAutoResumeRef.current) return;
      hasAttemptedAutoResumeRef.current = true;
      setIsResuming(true);
      setResumeError(null);

      resumeAgentSession(session.workspaceId!, agentSessionId)
        .then(() => {
          setSession((prev) => {
            if (!prev) return prev;
            return { ...prev, isIdle: false, agentCompletedAt: null } as ChatSessionResponse;
          });
          setIsResuming(false);
        })
        .catch((err) => {
          setIsResuming(false);
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')) {
            setResumeError('Could not resume agent \u2014 workspace may have been cleaned up.');
          } else {
            console.error('Auto-resume failed:', msg);
            setResumeError('Could not resume agent \u2014 please try again.');
          }
        });
    }, AUTO_RESUME_DELAY_MS);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState, isResuming, isProvisioning, session?.workspaceId, agentSessionId]);

  // Debounced connection banner
  useEffect(() => {
    if (connectionState === 'connected' || connectionState === 'disconnected') {
      setShowConnectionBanner(connectionState === 'disconnected');
      return;
    }
    const timer = setTimeout(() => setShowConnectionBanner(true), RECONNECT_BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connectionState]);

  // Resume an idle session and optionally send a follow-up prompt via REST API
  const resumeAndSend = useCallback((followUpText?: string) => {
    if (!session?.workspaceId || !agentSessionId) return;
    hasAttemptedAutoResumeRef.current = true;
    setIsResuming(true);
    setResumeError(null);

    resumeAgentSession(session.workspaceId, agentSessionId)
      .then(async () => {
        setSession((prev) => {
          if (!prev) return prev;
          return { ...prev, isIdle: false, agentCompletedAt: null } as ChatSessionResponse;
        });
        setIsResuming(false);
        if (followUpText) {
          try {
            await sendFollowUpPrompt(projectId, sessionId, followUpText);
          } catch {
            // Agent may be offline — message is still persisted via DO
          }
        }
      })
      .catch((err) => {
        setIsResuming(false);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')) {
          setResumeError('Could not resume agent \u2014 workspace may have been cleaned up.');
        } else {
          console.error('Agent resume failed:', msg);
          setResumeError('Could not resume agent \u2014 please try again.');
        }
      });
  }, [session?.workspaceId, agentSessionId, projectId, sessionId, setSession]);

  return {
    isResuming,
    resumeError,
    showConnectionBanner,
    idleCountdownMs,
    resumeAndSend,
  };
}
