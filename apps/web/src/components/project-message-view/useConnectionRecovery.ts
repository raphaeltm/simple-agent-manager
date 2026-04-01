import { useEffect, useRef, useState } from 'react';

import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import type { UseProjectAgentSessionReturn } from '../../hooks/useProjectAgentSession';
import type { ChatSessionResponse } from '../../lib/api';
import { resumeAgentSession, saveCachedCommands } from '../../lib/api';

import type { SessionState } from './types';
import {
  ACP_GRACE_MS,
  ACP_RECOVERY_DELAY_MS,
  ACP_RECOVERY_INTERVAL_MS,
  ACP_RECOVERY_MAX_ATTEMPTS,
  AUTO_RESUME_DELAY_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  RECONNECT_BANNER_DELAY_MS,
} from './types';

export interface UseConnectionRecoveryOptions {
  sessionId: string;
  projectId: string;
  sessionState: SessionState;
  connectionState: ChatConnectionState;
  agentSession: UseProjectAgentSessionReturn;
  agentSessionId: string | null;
  session: ChatSessionResponse | null;
  isProvisioning: boolean;
  setSession: React.Dispatch<React.SetStateAction<ChatSessionResponse | null>>;
}

export interface UseConnectionRecoveryResult {
  isResuming: boolean;
  setIsResuming: (v: boolean) => void;
  resumeError: string | null;
  setResumeError: (v: string | null) => void;
  showConnectionBanner: boolean;
  acpGrace: boolean;
  committedToDoViewRef: React.RefObject<boolean>;
  idleCountdownMs: number | null;
  pendingFollowUpRef: React.MutableRefObject<string | null>;
  hasAttemptedAutoResumeRef: React.MutableRefObject<boolean>;
}

export function useConnectionRecovery(opts: UseConnectionRecoveryOptions): UseConnectionRecoveryResult {
  const {
    sessionId,
    projectId,
    sessionState,
    connectionState,
    agentSession,
    agentSessionId,
    session,
    isProvisioning,
    setSession,
  } = opts;

  // Auto-resume state
  const [isResuming, setIsResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const pendingFollowUpRef = useRef<string | null>(null);
  const hasAttemptedAutoResumeRef = useRef(false);

  // ACP recovery
  const acpRecoveryAttemptsRef = useRef(0);
  const acpRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connection banner debounce
  const [showConnectionBanner, setShowConnectionBanner] = useState(false);

  // Grace period for ACP→DO handoff
  const [acpGrace, setAcpGrace] = useState(false);
  const acpGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasPromptingRef = useRef(false);
  const committedToDoViewRef = useRef(false);

  // Idle timer
  const [idleCountdownMs, setIdleCountdownMs] = useState<number | null>(null);

  // Reset state when switching sessions
  useEffect(() => {
    setAcpGrace(false);
    wasPromptingRef.current = false;
    committedToDoViewRef.current = false;
    setIsResuming(false);
    setResumeError(null);
    pendingFollowUpRef.current = null;
    hasAttemptedAutoResumeRef.current = false;
    acpRecoveryAttemptsRef.current = 0;
    if (acpRecoveryTimerRef.current) {
      clearTimeout(acpRecoveryTimerRef.current);
      acpRecoveryTimerRef.current = null;
    }
    setShowConnectionBanner(false);
    if (acpGraceTimerRef.current) {
      clearTimeout(acpGraceTimerRef.current);
      acpGraceTimerRef.current = null;
    }
  }, [sessionId]);

  // Persist agent commands
  const prevCommandCountRef = useRef(0);
  useEffect(() => {
    const cmds = agentSession.messages.availableCommands;
    if (cmds.length === 0 || cmds.length === prevCommandCountRef.current) return;
    prevCommandCountRef.current = cmds.length;
    const agentType = agentSession.session.agentType ?? 'claude-code';
    saveCachedCommands(projectId, agentType, cmds.map((c) => ({ name: c.name, description: c.description }))).catch(() => { /* best-effort */ });
  }, [agentSession.messages.availableCommands, agentSession.session.agentType, projectId]);

  // ACP→DO handoff grace period
  useEffect(() => {
    const { isPrompting } = agentSession;
    if (isPrompting) {
      wasPromptingRef.current = true;
      if (acpGraceTimerRef.current) {
        clearTimeout(acpGraceTimerRef.current);
        acpGraceTimerRef.current = null;
      }
      setAcpGrace(false);
    } else if (wasPromptingRef.current) {
      wasPromptingRef.current = false;
      setAcpGrace(true);
      acpGraceTimerRef.current = setTimeout(() => {
        committedToDoViewRef.current = true;
        setAcpGrace(false);
        acpGraceTimerRef.current = null;
      }, ACP_GRACE_MS);
    }
    return () => {
      if (acpGraceTimerRef.current) {
        clearTimeout(acpGraceTimerRef.current);
        acpGraceTimerRef.current = null;
      }
    };
  }, [agentSession.isPrompting]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Post-resume message flush
  useEffect(() => {
    if (!agentSession.isAgentActive || !isResuming) return;
    if (pendingFollowUpRef.current) {
      const queued = pendingFollowUpRef.current;
      pendingFollowUpRef.current = null;
      agentSession.sendPrompt(queued);
    }
    setIsResuming(false);
    setResumeError(null);
  }, [agentSession.isAgentActive, agentSession.sendPrompt, isResuming]);

  // Auto-resume for idle sessions
  useEffect(() => {
    if (
      sessionState !== 'idle' ||
      agentSession.isAgentActive ||
      agentSession.isConnecting ||
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
          agentSession.reconnect();
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
  }, [sessionState, agentSession.isAgentActive, agentSession.isConnecting, isResuming, isProvisioning, session?.workspaceId, agentSessionId]);

  // ACP recovery for active sessions with error state
  const acpState = agentSession.session.state;
  useEffect(() => {
    if (
      sessionState !== 'active' ||
      acpState !== 'error' ||
      isResuming ||
      isProvisioning ||
      !session?.workspaceId ||
      !agentSessionId
    ) {
      if (acpRecoveryTimerRef.current) {
        clearTimeout(acpRecoveryTimerRef.current);
        acpRecoveryTimerRef.current = null;
      }
      if (agentSession.isAgentActive) {
        acpRecoveryAttemptsRef.current = 0;
      }
      return;
    }

    if (acpRecoveryAttemptsRef.current >= ACP_RECOVERY_MAX_ATTEMPTS) return;

    const delay = acpRecoveryAttemptsRef.current === 0
      ? ACP_RECOVERY_DELAY_MS
      : ACP_RECOVERY_INTERVAL_MS;

    acpRecoveryTimerRef.current = setTimeout(() => {
      acpRecoveryTimerRef.current = null;
      const attempt = ++acpRecoveryAttemptsRef.current;

      resumeAgentSession(session.workspaceId!, agentSessionId)
        .then(() => {
          setSession((prev) => {
            if (!prev) return prev;
            return { ...prev, isIdle: false, agentCompletedAt: null } as ChatSessionResponse;
          });
          agentSession.reconnect();
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')) {
            acpRecoveryAttemptsRef.current = ACP_RECOVERY_MAX_ATTEMPTS;
          } else {
            console.warn(`ACP recovery attempt ${attempt} failed:`, msg);
          }
        });
    }, delay);

    return () => {
      if (acpRecoveryTimerRef.current) {
        clearTimeout(acpRecoveryTimerRef.current);
        acpRecoveryTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState, acpState, agentSession.isAgentActive, isResuming, isProvisioning, session?.workspaceId, agentSessionId]);

  // Debounced connection banner
  useEffect(() => {
    if (connectionState === 'connected' || connectionState === 'disconnected') {
      setShowConnectionBanner(connectionState === 'disconnected');
      return;
    }
    const timer = setTimeout(() => setShowConnectionBanner(true), RECONNECT_BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connectionState]);

  return {
    isResuming,
    setIsResuming,
    resumeError,
    setResumeError,
    showConnectionBanner,
    acpGrace,
    committedToDoViewRef,
    idleCountdownMs,
    pendingFollowUpRef,
    hasAttemptedAutoResumeRef,
  };
}
