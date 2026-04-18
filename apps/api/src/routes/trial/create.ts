/**
 * POST /api/trial/create — create a new anonymous trial.
 *
 * Flow:
 *   1. Validate the request body (Valibot — Wave-0 schema).
 *   2. Read the kill switch; return `trials_disabled` when the KV flag is off
 *      or unreachable (fail-closed — see services/trial/kill-switch.ts).
 *   3. Canonicalise the GitHub repo URL and probe `api.github.com/repos/...`
 *      to reject private, 404, or oversized (> TRIAL_REPO_MAX_KB) repositories.
 *   4. Ask TrialCounter (global singleton DO) to allocate a slot for the
 *      current UTC month. `cap_exceeded` -> 429 with `waitlistResetsAt`.
 *   5. Mint a trialId + UUID fingerprint, persist the trial row (status=pending),
 *      and issue the signed cookies (fingerprint 7d, claim 48h).
 *   6. Return { trialId, projectId?, eventsUrl, expiresAt } — projectId is
 *      populated by the Track-B orchestrator and is absent until provisioned.
 *
 * This route is the Wave-1 Track-A hand-off point. The SSE companion
 * (`GET /api/trial/events`) and the project/provisioning flow are owned by
 * other tracks and consume the trial row this route creates.
 */
import {
  TRIAL_COOKIE_FINGERPRINT_NAME,
  type TrialCreateError,
  TrialCreateRequestSchema,
  type TrialCreateResponse,
  type TrialErrorCode,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { TrialCounterTryIncrementResult } from '../../durable-objects/trial-counter';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  buildClaimCookie,
  buildFingerprintCookie,
  signClaimToken,
  signFingerprint,
  type TrialClaimPayload,
} from '../../services/trial/cookies';
import {
  currentMonthKey,
  getTrialCounterStub,
  nextMonthResetDate,
  parseGithubRepoUrl,
  resolveGithubTimeoutMs,
  resolveMonthlyCap,
  resolveRepoMaxKb,
  resolveWorkspaceTtlMs,
} from '../../services/trial/helpers';
import { isTrialsEnabled } from '../../services/trial/kill-switch';

const createRoutes = new Hono<{ Bindings: Env }>();

// Exposed for tests (and for other tracks that want to probe GitHub the same way).
export interface GithubRepoProbe {
  ok: true;
  sizeKb: number;
  private: boolean;
}

export interface GithubRepoProbeError {
  ok: false;
  reason: Extract<TrialErrorCode, 'repo_not_found' | 'repo_private' | 'repo_too_large'>;
}

/**
 * Probe `https://api.github.com/repos/{owner}/{name}` to verify that the
 * repository is public, exists, and fits within the trial size budget.
 *
 * A 404 -> repo_not_found. `private: true` -> repo_private. size > maxKb
 * -> repo_too_large. Any other non-2xx (rate-limit, 5xx, network error)
 * is treated as repo_not_found so the user isn't left without a signal.
 */
export async function probeGithubRepo(
  owner: string,
  name: string,
  opts: { maxKb: number; timeoutMs: number; fetchFn?: typeof fetch }
): Promise<GithubRepoProbe | GithubRepoProbeError> {
  const fetchFn = opts.fetchFn ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const resp = await fetchFn(
      `https://api.github.com/repos/${owner}/${name}`,
      {
        // GitHub REST API requires a UA on unauthenticated requests.
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'sam-trial-onboarding',
        },
        signal: ac.signal,
      }
    );
    if (resp.status === 404) return { ok: false, reason: 'repo_not_found' };
    if (!resp.ok) return { ok: false, reason: 'repo_not_found' };
    const body = (await resp.json()) as {
      private?: boolean;
      size?: number;
    };
    if (body.private === true) return { ok: false, reason: 'repo_private' };
    const sizeKb = Number(body.size ?? 0);
    if (sizeKb > opts.maxKb) return { ok: false, reason: 'repo_too_large' };
    return { ok: true, sizeKb, private: false };
  } catch {
    return { ok: false, reason: 'repo_not_found' };
  } finally {
    clearTimeout(timer);
  }
}

function errorResponse(
  code: TrialErrorCode,
  message: string,
  status: number,
  extra?: Partial<TrialCreateError>
): Response {
  const body: TrialCreateError = { error: code, message, ...extra };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

function randomId(prefix: string): string {
  // crypto.randomUUID is available in Workers/modern Node.
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

createRoutes.post('/create', async (c) => {
  const env = c.env;
  const now = Date.now();

  // -- 1. Validate body ------------------------------------------------------
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse('invalid_url', 'Request body must be valid JSON', 400);
  }
  const parsed = v.safeParse(TrialCreateRequestSchema, body);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    return errorResponse(
      'invalid_url',
      issue?.message ?? 'Must be a public GitHub repository URL',
      400
    );
  }

  const repo = parseGithubRepoUrl(parsed.output.repoUrl);
  if (!repo) {
    return errorResponse(
      'invalid_url',
      'Must be a public GitHub repository URL',
      400
    );
  }

  // -- 2. Kill switch --------------------------------------------------------
  const enabled = await isTrialsEnabled(env, now);
  if (!enabled) {
    return errorResponse(
      'trials_disabled',
      'Trial onboarding is currently disabled',
      503
    );
  }

  // Secret must be present whenever trials are enabled.
  const secret = env.TRIAL_CLAIM_TOKEN_SECRET;
  if (!secret) {
    log.error('trial.create.missing_secret', {});
    return errorResponse(
      'trials_disabled',
      'Trial onboarding is misconfigured',
      503
    );
  }

  // -- 3. GitHub repo probe --------------------------------------------------
  const probe = await probeGithubRepo(repo.owner, repo.name, {
    maxKb: resolveRepoMaxKb(env),
    timeoutMs: resolveGithubTimeoutMs(env),
  });
  if (!probe.ok) {
    const status =
      probe.reason === 'repo_not_found'
        ? 404
        : probe.reason === 'repo_private'
          ? 403
          : 413;
    return errorResponse(
      probe.reason,
      {
        repo_not_found: 'Repository not found or not publicly accessible',
        repo_private: 'Repository is private',
        repo_too_large: 'Repository exceeds the trial size limit',
      }[probe.reason],
      status
    );
  }

  // -- 4. Allocate a slot on the TrialCounter DO -----------------------------
  const monthKey = currentMonthKey(now);
  const cap = resolveMonthlyCap(env);
  const counter = getTrialCounterStub(env);
  let slot: TrialCounterTryIncrementResult;
  try {
    // RPC path — typed method call on the DO stub.
    slot = await (
      counter as unknown as {
        tryIncrement(
          monthKey: string,
          cap: number
        ): Promise<TrialCounterTryIncrementResult>;
      }
    ).tryIncrement(monthKey, cap);
  } catch (err) {
    log.error('trial.create.counter_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail closed if the counter DO is unreachable.
    return errorResponse(
      'trials_disabled',
      'Trial slot allocation unavailable — please retry shortly',
      503
    );
  }

  if (!slot.allowed) {
    return errorResponse(
      'cap_exceeded',
      'Monthly trial cap reached — join the waitlist to be notified',
      429,
      { waitlistResetsAt: nextMonthResetDate(now) }
    );
  }

  // -- 5. Persist the trial row ---------------------------------------------
  const trialId = randomId('trial');
  const ttlMs = resolveWorkspaceTtlMs(env);
  const expiresAt = now + ttlMs;

  // Determine (or mint) the visitor fingerprint. The same anonymous visitor
  // reuses the same fingerprint across multiple trials within the 7d cookie
  // lifetime, which makes support/abuse investigations tractable.
  const existingFp = readCookie(
    c.req.header('cookie') ?? null,
    TRIAL_COOKIE_FINGERPRINT_NAME
  );
  let fingerprintUuid: string | null = null;
  if (existingFp) {
    const dot = existingFp.lastIndexOf('.');
    if (dot > 0) fingerprintUuid = existingFp.slice(0, dot);
  }
  if (!fingerprintUuid) fingerprintUuid = crypto.randomUUID();

  const db = drizzle(env.DATABASE, { schema });
  try {
    await db.insert(schema.trials).values({
      id: trialId,
      fingerprint: fingerprintUuid,
      repoUrl: repo.canonical,
      repoOwner: repo.owner,
      repoName: repo.name,
      monthKey,
      status: 'pending',
      projectId: null,
      claimedByUserId: null,
      createdAt: now,
      expiresAt,
      claimedAt: null,
      errorCode: null,
      errorMessage: null,
    });
  } catch (err) {
    log.error('trial.create.insert_failed', {
      trialId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Release the allocated counter slot so a failed insert doesn't burn
    // a monthly slot for the user.
    try {
      await (
        counter as unknown as { decrement(monthKey: string): Promise<number> }
      ).decrement(monthKey);
    } catch (decErr) {
      log.error('trial.create.counter_decrement_failed', {
        trialId,
        error: decErr instanceof Error ? decErr.message : String(decErr),
      });
    }
    return errorResponse(
      'trials_disabled',
      'Trial creation failed — please retry shortly',
      500
    );
  }

  // -- 6. Issue cookies + return --------------------------------------------
  const fingerprintSigned = await signFingerprint(fingerprintUuid, secret);
  const claimPayload: TrialClaimPayload = {
    trialId,
    // Placeholder — the SSE orchestrator will re-issue a fresh claim cookie
    // once the project row exists. Until then the client has a signed token
    // bound to the trialId alone, which is sufficient for claim validation.
    projectId: '',
    issuedAt: now,
    expiresAt: now + 1000 * 60 * 60 * 48, // 48h
  };
  const claimSigned = await signClaimToken(claimPayload, secret);

  const cookieDomain = env.BASE_DOMAIN ? `.${env.BASE_DOMAIN}` : undefined;
  const secure = true; // HTTPS-only on every Worker deployment

  const respBody: TrialCreateResponse = {
    trialId,
    projectId: '', // populated once Track-B provisions the project row
    eventsUrl: `/api/trial/events?trialId=${encodeURIComponent(trialId)}`,
    expiresAt,
  };

  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append(
    'set-cookie',
    buildFingerprintCookie(fingerprintSigned, {
      secure,
      domain: cookieDomain,
    })
  );
  headers.append(
    'set-cookie',
    buildClaimCookie(claimSigned, { secure, domain: cookieDomain })
  );

  log.info('trial.create.ok', {
    trialId,
    monthKey,
    slotCount: slot.count,
    cap,
    repo: repo.canonical,
    // fingerprint deliberately omitted from structured logs — it's PII-adjacent
  });

  return new Response(JSON.stringify(respBody), {
    status: 201,
    headers,
  });
});

export { createRoutes };
