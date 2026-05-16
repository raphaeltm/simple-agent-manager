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
import { parseTrialEvent } from '@simple-agent-manager/shared';

import { API_URL } from './api/client';
import { expectJsonRecord, maybeJsonRecord } from './runtime-validation';

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

function isTrialErrorCode(code: unknown): code is TrialErrorCode {
  return typeof code === 'string' && code in ERROR_COPY;
}

function normalizeTrialErrorCode(code: unknown): TrialErrorCode {
  return isTrialErrorCode(code) ? code : 'invalid_url';
}

export function trialErrorMessage(code: string, fallback?: string): string {
  return isTrialErrorCode(code)
    ? ERROR_COPY[code]
    : fallback ?? 'Something went wrong. Please try again.';
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

  const parsed: unknown = await resp.json().catch(() => ({}));
  const raw = maybeJsonRecord(parsed) ?? {};

  if (resp.ok) {
    // Normal success: { trialId, projectId, eventsUrl, expiresAt }
    if (
      typeof raw.trialId === 'string' &&
      typeof raw.projectId === 'string' &&
      typeof raw.eventsUrl === 'string' &&
      typeof raw.expiresAt === 'number'
    ) {
      const value: TrialCreateResponse = {
        trialId: raw.trialId,
        projectId: raw.projectId,
        eventsUrl: raw.eventsUrl,
        expiresAt: raw.expiresAt,
      };
      return { ok: true, value };
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
  const code = normalizeTrialErrorCode(raw.error);
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
  const parsed: unknown = await resp.json().catch(() => ({}));
  const data = maybeJsonRecord(parsed) ?? {};
  if (!resp.ok) {
    throw new Error(
      typeof data.message === 'string'
        ? data.message
        : 'Could not join the waitlist. Please try again.'
    );
  }
  return {
    queued: typeof data.queued === 'boolean' ? data.queued : true,
    resetsAt: typeof data.resetsAt === 'string' ? data.resetsAt : '',
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
      const parsed = expectJsonRecord(JSON.parse(msg.data), 'trial.sse_event');
      handlers.onEvent(parseTrialEvent(parsed));
    } catch (err) {
      console.warn('trial: failed to parse SSE payload', err);
    }
  };

  source.onerror = (ev) => {
    handlers.onError?.(ev);
  };

  return source;
}
