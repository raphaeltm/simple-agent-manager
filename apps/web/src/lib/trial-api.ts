/**
 * Trial onboarding — browser API client.
 *
 * All endpoints use cookies (HttpOnly signed fingerprint + claim token) so
 * callers don't need to pass credentials explicitly.
 */
import type {
  TrialCreateError,
  TrialCreateRequest,
  TrialCreateResponse,
  TrialErrorCode,
  TrialEvent,
  TrialWaitlistRequest,
  TrialWaitlistResponse,
} from '@simple-agent-manager/shared';

import { API_URL } from './api/client';

/**
 * Inline error copy, per error code, for the landing page. Kept in one place so
 * tests and UI stay in sync.
 */
const ERROR_COPY: Record<TrialErrorCode, string> = {
  invalid_url: "That doesn't look like a public GitHub repo URL.",
  repo_not_found: "We couldn't find that repo. Is it public?",
  repo_private: 'That repo is private. Trials only support public GitHub repos.',
  repo_too_large: 'That repo is too large for a trial (max 500 MB).',
  trials_disabled: 'Trials are paused right now — come back soon.',
  cap_exceeded: "We've hit our trial cap for the month.",
  existing_trial: 'You already have an active trial — resuming it now.',
};

export function trialErrorMessage(code: TrialErrorCode, fallback?: string): string {
  return ERROR_COPY[code] ?? fallback ?? 'Something went wrong. Please try again.';
}

/**
 * Response shape when the server tells the client about an already-running
 * trial. Either an HTTP-200 success with `existingTrialId` (per §3.1 of the
 * idea) OR an error-body form with the same trial coordinates.
 */
export interface ExistingTrialRedirect {
  trialId: string;
  projectId: string;
}

export type CreateTrialResult =
  | { ok: true; value: TrialCreateResponse }
  | { ok: true; existing: ExistingTrialRedirect }
  | { ok: false; error: TrialCreateError };

/**
 * POST /api/trial/create — validate the repo URL and kick off the workspace.
 *
 * Returns a discriminated union so callers can handle all branches (new trial,
 * existing trial, known error codes) without try/catch noise. Rejects only on
 * truly unexpected network or JSON-parse failures.
 */
export async function createTrial(repoUrl: string): Promise<CreateTrialResult> {
  const body: TrialCreateRequest = { repoUrl };

  const resp = await fetch(`${API_URL}/api/trial/create`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = (await resp.json().catch(() => ({}))) as Record<string, unknown>;

  if (resp.ok) {
    // Normal success: { trialId, projectId, eventsUrl, expiresAt }
    if (typeof raw.trialId === 'string' && typeof raw.projectId === 'string') {
      return { ok: true, value: raw as unknown as TrialCreateResponse };
    }
    // Returning-user success (per §3.1): `{ existingTrialId, projectId }` at 200.
    if (typeof raw.existingTrialId === 'string' && typeof raw.projectId === 'string') {
      return {
        ok: true,
        existing: { trialId: raw.existingTrialId, projectId: raw.projectId },
      };
    }
  }

  // Error branch — normalize.
  const code = (typeof raw.error === 'string' ? raw.error : 'invalid_url') as TrialErrorCode;
  const message =
    typeof raw.message === 'string' ? raw.message : trialErrorMessage(code);

  // existing_trial-as-error form: surface the trial coordinates for redirect.
  if (
    code === 'existing_trial' &&
    typeof raw.trialId === 'string' &&
    typeof raw.projectId === 'string'
  ) {
    return {
      ok: true,
      existing: { trialId: raw.trialId, projectId: raw.projectId },
    };
  }

  const error: TrialCreateError = { error: code, message };
  if (code === 'cap_exceeded' && typeof raw.waitlistResetsAt === 'string') {
    error.waitlistResetsAt = raw.waitlistResetsAt;
  }
  return { ok: false, error };
}

/**
 * POST /api/trial/waitlist — queue an email for when trials re-open.
 *
 * Throws on non-2xx responses; callers render inline errors from the thrown
 * message. Validation is done server-side via Valibot; the client does a
 * light regex pre-check to avoid wasted round-trips.
 */
export async function joinWaitlist(email: string): Promise<TrialWaitlistResponse> {
  const body: TrialWaitlistRequest = { email };
  const resp = await fetch(`${API_URL}/api/trial/waitlist`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    queued?: boolean;
    resetsAt?: string;
    message?: string;
  };
  if (!resp.ok) {
    throw new Error(data.message ?? 'Could not join the waitlist. Please try again.');
  }
  return {
    queued: data.queued ?? true,
    resetsAt: data.resetsAt ?? '',
  };
}

/**
 * Open an EventSource for `GET /api/trial/:trialId/events`.
 *
 * Callers own the returned source and must close it on unmount. The browser's
 * built-in EventSource auto-reconnects on transport errors; callers who need
 * bounded retry with exponential backoff can close the source in `onError`
 * and re-invoke this function from a retry timer.
 */
export function openTrialEventStream(
  trialId: string,
  handlers: {
    onEvent: (event: TrialEvent) => void;
    onError?: (event: Event) => void;
    onOpen?: () => void;
  },
): EventSource {
  const source = new EventSource(
    `${API_URL}/api/trial/${encodeURIComponent(trialId)}/events`,
    { withCredentials: true },
  );

  source.onopen = () => {
    handlers.onOpen?.();
  };

  source.onmessage = (msg: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(msg.data) as TrialEvent;
      if (parsed && typeof parsed.type === 'string') {
        handlers.onEvent(parsed);
      }
    } catch (err) {
      console.warn('trial: failed to parse SSE payload', err);
    }
  };

  source.onerror = (ev) => {
    handlers.onError?.(ev);
  };

  return source;
}
