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
import {
  DEFAULT_DELIVERY_ERROR_MESSAGE,
  getResumeFailureMessage,
  getRuntimeRecoveryMessage,
  isRuntimeStoppedError,
} from './runtimeRecoveryMessages';
import type { SessionState } from './types';
import { AUTO_RESUME_DELAY_MS, DEFAULT_IDLE_TIMEOUT_MS, RECONNECT_BANNER_DELAY_MS } from './types';

/** Outcome callbacks for a follow-up dispatched through the resume path. */
export interface ResumeSendHandlers {
  /** Fired once the follow-up was resumed AND delivered successfully. */
  onDelivered?: () => void;
  /** Fired when the resume or the delivery failed (including terminal stop). */
  onFailed?: () => void;
}

/** A follow-up queued to send after the in-flight/next resume succeeds. */
interface PendingFollowUp {
  text: string;
  handlers?: ResumeSendHandlers;
}

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
  /** Timestamp (ms) the current resume began, for live elapsed-time display. */
  resumeStartedAt: number | null;
  resumeError: string | null;
  showConnectionBanner: boolean;
  idleCountdownMs: number | null;
  clearResumeError: () => void;
  reportDeliveryError: (error: unknown) => void;
  /** Resume an idle session and optionally send a follow-up prompt. */
  resumeAndSend: (followUpText?: string, handlers?: ResumeSendHandlers) => void;
}

export function useConnectionRecovery(
  opts: UseConnectionRecoveryOptions
): UseConnectionRecoveryResult {
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
  const [resumeStartedAt, setResumeStartedAt] = useState<number | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const hasAttemptedAutoResumeRef = useRef(false);

  // Re-entrancy + ordering guards (UX4):
  // - isResumingRef mirrors `isResuming` synchronously so overlapping callers
  //   (auto-resume timer vs. a user-initiated send) never launch two resumes.
  // - resumeAttemptRef is a monotonic token; only the newest attempt's
  //   settlement is allowed to mutate state, so a stale (superseded or
  //   session-switched) resume can never clobber newer state.
  // - pendingFollowUpRef carries the user's follow-up so it is delivered when
  //   the in-flight resume settles (piggyback instead of a second resume).
  const isResumingRef = useRef(false);
  const resumeAttemptRef = useRef(0);
  const pendingFollowUpRef = useRef<PendingFollowUp | null>(null);

  const clearResumeError = useCallback(() => setResumeError(null), []);

  /**
   * Reflect a terminal RUNTIME_STOPPED in local session state so the existing
   * terminated presentation (composer disabled) takes over. Reuses the same
   * `status: 'stopped'` transition the WebSocket "session stopped" path uses.
   */
  const markTerminated = useCallback(() => {
    setSession((prev) => (prev ? ({ ...prev, status: 'stopped' } as ChatSessionResponse) : prev));
  }, [setSession]);

  // Delivery failure: terminal stop → terminate (no banner); otherwise banner.
  const applyDeliveryError = useCallback(
    (error: unknown) => {
      if (isRuntimeStoppedError(error)) {
        setResumeError(null);
        markTerminated();
        return;
      }
      setResumeError(getRuntimeRecoveryMessage(error) ?? DEFAULT_DELIVERY_ERROR_MESSAGE);
    },
    [markTerminated]
  );

  // Resume failure: terminal stop → terminate (no banner); otherwise banner.
  const applyResumeError = useCallback(
    (error: unknown) => {
      if (isRuntimeStoppedError(error)) {
        setResumeError(null);
        markTerminated();
        return;
      }
      setResumeError(getResumeFailureMessage(error));
    },
    [markTerminated]
  );

  const reportDeliveryError = useCallback(
    (error: unknown) => applyDeliveryError(error),
    [applyDeliveryError]
  );

  // Connection banner debounce
  const [showConnectionBanner, setShowConnectionBanner] = useState(false);

  // Idle timer
  const [idleCountdownMs, setIdleCountdownMs] = useState<number | null>(null);

  // Reset state when switching sessions. Bumping the attempt token invalidates
  // any in-flight resume from the previous session so its settlement cannot
  // mutate the new session's state.
  useEffect(() => {
    setIsResuming(false);
    setResumeStartedAt(null);
    setResumeError(null);
    hasAttemptedAutoResumeRef.current = false;
    isResumingRef.current = false;
    resumeAttemptRef.current += 1;
    pendingFollowUpRef.current = null;
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

  const agentSessionId = session?.agentSessionId ?? null;
  const workspaceId = session?.workspaceId ?? null;

  // Shared resume core used by BOTH the auto-resume timer and user-initiated
  // sends. Guarantees a single in-flight resume (re-entrancy guard) and that
  // only the newest attempt mutates state (monotonic token).
  const beginResume = useCallback(
    (followUp?: PendingFollowUp) => {
      if (!workspaceId || !agentSessionId) {
        followUp?.handlers?.onFailed?.();
        return;
      }

      // Re-entrancy: a resume is already running — piggyback the follow-up onto
      // it rather than launching an overlapping resume.
      if (isResumingRef.current) {
        if (followUp) pendingFollowUpRef.current = followUp;
        return;
      }

      hasAttemptedAutoResumeRef.current = true;
      const attempt = (resumeAttemptRef.current += 1);
      isResumingRef.current = true;
      setIsResuming(true);
      setResumeStartedAt(Date.now());
      setResumeError(null);
      if (followUp) pendingFollowUpRef.current = followUp;

      resumeAgentSession(workspaceId, agentSessionId)
        .then(async () => {
          // Stale (superseded by a newer attempt or a session switch) — do not
          // touch state or send, and leave `isResuming` to the newest attempt.
          if (attempt !== resumeAttemptRef.current) return;
          isResumingRef.current = false;
          setIsResuming(false);
          setResumeStartedAt(null);
          setSession((prev) =>
            prev ? ({ ...prev, isIdle: false, agentCompletedAt: null } as ChatSessionResponse) : prev
          );

          const pending = pendingFollowUpRef.current;
          pendingFollowUpRef.current = null;
          if (!pending) return;
          try {
            await sendFollowUpPrompt(projectId, sessionId, pending.text);
            if (attempt !== resumeAttemptRef.current) return;
            setResumeError(null);
            pending.handlers?.onDelivered?.();
          } catch (err) {
            if (attempt !== resumeAttemptRef.current) return;
            applyDeliveryError(err);
            pending.handlers?.onFailed?.();
          }
        })
        .catch((err) => {
          if (attempt !== resumeAttemptRef.current) return;
          isResumingRef.current = false;
          setIsResuming(false);
          setResumeStartedAt(null);
          const pending = pendingFollowUpRef.current;
          pendingFollowUpRef.current = null;
          applyResumeError(err);
          pending?.handlers?.onFailed?.();
        });
    },
    [
      workspaceId,
      agentSessionId,
      projectId,
      sessionId,
      setSession,
      applyDeliveryError,
      applyResumeError,
    ]
  );

  // Auto-resume reads `beginResume` through a ref so the timer effect does NOT
  // list it as a dependency — otherwise a `session` object identity change
  // during the 2s window would clear and restart the timer, delaying (or
  // starving) auto-resume indefinitely.
  const beginResumeRef = useRef(beginResume);
  useEffect(() => {
    beginResumeRef.current = beginResume;
  }, [beginResume]);

  // Auto-resume for idle sessions (one attempt only)
  useEffect(() => {
    if (
      sessionState !== 'idle' ||
      isResuming ||
      isProvisioning ||
      !workspaceId ||
      !agentSessionId ||
      hasAttemptedAutoResumeRef.current
    )
      return;

    const timer = setTimeout(() => {
      if (hasAttemptedAutoResumeRef.current || isResumingRef.current) return;
      beginResumeRef.current();
    }, AUTO_RESUME_DELAY_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState, isResuming, isProvisioning, workspaceId, agentSessionId]);

  // Debounced connection banner
  useEffect(() => {
    if (connectionState === 'connected' || connectionState === 'disconnected') {
      setShowConnectionBanner(connectionState === 'disconnected');
      return;
    }
    const timer = setTimeout(() => setShowConnectionBanner(true), RECONNECT_BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connectionState]);

  // Resume an idle session and optionally send a follow-up prompt via REST API.
  const resumeAndSend = useCallback(
    (followUpText?: string, handlers?: ResumeSendHandlers) => {
      beginResume(followUpText ? { text: followUpText, handlers } : undefined);
    },
    [beginResume]
  );

  return {
    isResuming,
    resumeStartedAt,
    resumeError,
    showConnectionBanner,
    idleCountdownMs,
    clearResumeError,
    reportDeliveryError,
    resumeAndSend,
  };
}
