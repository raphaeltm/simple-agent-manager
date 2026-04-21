/**
 * useTrialClaim — post-login claim + auto-submit hook.
 *
 * After a trial visitor signs in via GitHub OAuth, BetterAuth redirects them
 * back to `/try/:trialId?claim=1`. This hook:
 *
 *   1. POSTs to `/api/trial/claim` (Track B owns the endpoint) to transfer
 *      ownership of the anonymous trial project to the now-authenticated user.
 *   2. On success, reads any persisted draft via {@link useTrialDraft} and
 *      submits it as the first real chat message on the newly-owned project.
 *   3. Clears the draft and navigates to `/projects/:id`.
 *   4. On any error, sets `state.status = 'error'` — the caller is expected
 *      to fall back to the normal unclaimed discovery flow.
 *
 * The caller controls when the effect runs by passing `enabled` — typically
 * `true` only when the `?claim=1` query param is present.
 */
import type { TrialClaimResponse } from '@simple-agent-manager/shared';
import { useEffect, useRef, useState } from 'react';

import { request } from '../lib/api/client';
import { submitTask } from '../lib/api/tasks';
import { useTrialDraft } from './useTrialDraft';

export type TrialClaimStatus = 'idle' | 'claiming' | 'submitting' | 'done' | 'error';

export interface TrialClaimState {
  status: TrialClaimStatus;
  projectId: string | null;
  error: string | null;
}

export interface UseTrialClaimOptions {
  /** Only run the claim flow when this is true (e.g. `?claim=1` is present). */
  enabled: boolean;
  /** Called after successful claim+submit to navigate to the owned project. */
  onClaimed: (projectId: string) => void;
  /**
   * Optional override for the claim network call. Defaults to POSTing to
   * `/api/trial/claim`. Exposed for testing and for callers that want to
   * intercept (e.g. for cookie refresh).
   */
  claimRequest?: (trialId: string) => Promise<TrialClaimResponse>;
  /**
   * Optional override for the first-message submission. Defaults to
   * `submitTask(projectId, { message })`. Exposed for testing.
   */
  submitRequest?: (projectId: string, message: string) => Promise<unknown>;
}

async function defaultClaimRequest(trialId: string): Promise<TrialClaimResponse> {
  return request<TrialClaimResponse>('/api/trial/claim', {
    method: 'POST',
    body: JSON.stringify({ trialId }),
  });
}

async function defaultSubmitRequest(projectId: string, message: string): Promise<unknown> {
  return submitTask(projectId, { message });
}

/**
 * Drive the post-login claim handshake and auto-submit the saved draft.
 *
 * @returns Reactive state describing the current phase. The hook is fire-and-
 *   forget: the caller observes `state.status` and renders accordingly.
 */
export function useTrialClaim(
  trialId: string | undefined,
  options: UseTrialClaimOptions,
): TrialClaimState {
  const { enabled, onClaimed, claimRequest, submitRequest } = options;
  const { draft, clearDraft } = useTrialDraft(trialId);
  const [state, setState] = useState<TrialClaimState>({
    status: 'idle',
    projectId: null,
    error: null,
  });

  // Guard against StrictMode double-invoke and param flickers.
  const startedRef = useRef(false);
  // Stash stable refs so the one-shot effect doesn't re-fire when deps change.
  const draftRef = useRef(draft);
  const clearDraftRef = useRef(clearDraft);
  const onClaimedRef = useRef(onClaimed);
  const claimRequestRef = useRef(claimRequest ?? defaultClaimRequest);
  const submitRequestRef = useRef(submitRequest ?? defaultSubmitRequest);

  useEffect(() => {
    draftRef.current = draft;
    clearDraftRef.current = clearDraft;
    onClaimedRef.current = onClaimed;
    claimRequestRef.current = claimRequest ?? defaultClaimRequest;
    submitRequestRef.current = submitRequest ?? defaultSubmitRequest;
  }, [draft, clearDraft, onClaimed, claimRequest, submitRequest]);

  useEffect(() => {
    if (!enabled || !trialId || startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    void (async () => {
      setState({ status: 'claiming', projectId: null, error: null });
      let claim: TrialClaimResponse;
      try {
        claim = await claimRequestRef.current(trialId);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to claim trial';
        setState({ status: 'error', projectId: null, error: message });
        return;
      }

      if (cancelled) return;

      const pendingDraft = draftRef.current.trim();
      if (pendingDraft) {
        setState({ status: 'submitting', projectId: claim.projectId, error: null });
        try {
          await submitRequestRef.current(claim.projectId, pendingDraft);
        } catch (err) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : 'Failed to submit draft';
          setState({ status: 'error', projectId: claim.projectId, error: message });
          return;
        }
        if (cancelled) return;
        clearDraftRef.current();
      }

      setState({ status: 'done', projectId: claim.projectId, error: null });
      onClaimedRef.current(claim.projectId);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, trialId]);

  return state;
}
