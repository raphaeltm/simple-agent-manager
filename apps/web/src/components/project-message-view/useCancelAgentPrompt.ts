import { useCallback, useRef, useState } from 'react';

import { cancelAgentPrompt } from '../../lib/api';

export interface UseCancelAgentPromptOptions {
  projectId: string;
  sessionId: string;
  /** False while there is nothing to interrupt; the request is not sent. */
  enabled: boolean;
  /** Called once the agent has accepted the cancel. */
  onCancelled: () => void;
}

export interface UseCancelAgentPromptResult {
  /** True while the request is in flight, so the control can render progress. */
  cancelling: boolean;
  /** Message from the last failed attempt, or null. */
  cancelError: string | null;
  cancelPrompt: () => void;
  /** Drop a stale error — call when a new turn supersedes the failed interrupt. */
  clearCancelError: () => void;
}

/**
 * Interrupt the in-flight prompt, with a RENDERABLE in-flight guard and a
 * surfaced failure.
 *
 * Both chat surfaces previously hand-rolled this, and both had the same two
 * defects: the guard was a bare `useRef`, so every press during the request
 * (up to the node-agent request timeout) was dropped with no feedback at all —
 * the control looked idle, nothing happened, and users pressed it again — and
 * the `.catch()` was empty, so network/server failures vanished silently.
 *
 * Shared rather than fixed twice: the two copies had already drifted before this
 * hook existed (one cleared its error when a new turn started, the other left it
 * attached to work it had nothing to do with), which is precisely what
 * `.claude/rules/24` and `.claude/rules/59` exist to prevent.
 */
export function useCancelAgentPrompt({
  projectId,
  sessionId,
  enabled,
  onCancelled,
}: UseCancelAgentPromptOptions): UseCancelAgentPromptResult {
  // The ref is the SYNCHRONOUS guard — two clicks in the same tick must not both
  // get past it before React re-renders. The state is the RENDERABLE one.
  const inFlightRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const clearCancelError = useCallback(() => setCancelError(null), []);

  const cancelPrompt = useCallback(() => {
    if (!enabled || inFlightRef.current) return;
    inFlightRef.current = true;
    setCancelling(true);
    setCancelError(null);
    cancelAgentPrompt(projectId, sessionId)
      .then(() => {
        onCancelled();
      })
      .catch((err: unknown) => {
        // Surface the failure instead of swallowing it. The activity state is
        // deliberately left untouched so the control stays available to retry.
        setCancelError(err instanceof Error ? err.message : 'Failed to interrupt the agent');
      })
      .finally(() => {
        inFlightRef.current = false;
        setCancelling(false);
      });
  }, [enabled, onCancelled, projectId, sessionId]);

  return { cancelling, cancelError, cancelPrompt, clearCancelError };
}
