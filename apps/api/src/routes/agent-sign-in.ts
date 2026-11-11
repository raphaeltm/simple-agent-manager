/**
 * POST /api/auth/workload-identity-login — agent sign-in through workload identity.
 *
 * An agent on a trusted SAM instance exchanges the workload identity token that instance issued
 * (`exec_with_secrets` with `oidc: { audience }`) for an ordinary, short-lived session as an
 * allowed user here. Trust comes only from the deploy-time `AGENT_SIGN_IN_TRUST` secret
 * (`services/agent-sign-in/config.ts`); without it this handler steps aside and the request is
 * answered exactly as if the route did not exist.
 *
 * The session is created by the same path as token-login (`createSessionLogin`), so it passes
 * the same approval gate and BetterAuth session hooks. This endpoint never creates accounts and
 * never changes roles.
 *
 * Mounted under `/api/auth` before the BetterAuth catch-all (index.ts).
 */
import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { RateLimitError, rateLimit } from '../middleware/rate-limit';
import {
  AGENT_SIGN_IN_ROUTE,
  type AgentSignInTrust,
  agentSignInAudience,
  isAllowedSource,
  isAllowedTarget,
  resolveAgentSignInTrust,
} from '../services/agent-sign-in/config';
import { claimAgentSignIn, linkAgentSignInSession } from '../services/agent-sign-in/ledger';
import { verifyAgentSignInToken } from '../services/agent-sign-in/verify';
import { assertUserCanCreateSession, createSessionLogin } from '../services/session-factory';

const AgentSignInRequestSchema = v.object({
  token: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  /** The account to sign in as on this instance: its user ID or email address. */
  target: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(320)),
});

interface TargetUserRow {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  status: string | null;
}

const TARGET_NOT_ALLOWED = 'Target user is not allowed for agent sign-in';

async function findTargetUser(env: Env, target: string): Promise<TargetUserRow | null> {
  const byEmail = target.includes('@');
  const { results } = await env.DATABASE.prepare(
    `SELECT id, email, name, role, status FROM users
     WHERE ${byEmail ? 'lower(trim(email)) = ?' : 'id = ?'}
     ORDER BY id LIMIT 2`
  )
    .bind(byEmail ? target.toLowerCase() : target)
    .all<TargetUserRow>();
  // Two accounts on one address is ambiguous; never pick one.
  return results.length === 1 ? (results[0] ?? null) : null;
}

/**
 * BetterAuth's session hooks promote a user to superadmin only while no superadmin exists
 * (`LOGIN_SELF_HEAL_SQL` and `bootstrapSessionAllowed` in auth.ts / bootstrap-owner.ts). Requiring
 * one keeps both inert, so an agent sign-in can never change a role.
 */
async function hasEstablishedAdministrator(env: Env): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS present FROM users WHERE role = 'superadmin' AND status != 'system' LIMIT 1`
  ).first<{ present: number }>();
  return Boolean(row);
}

async function exchange(
  c: { env: Env; req: { json: () => Promise<unknown> } },
  trust: AgentSignInTrust
): Promise<Response> {
  const env = c.env;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw errors.badRequest('Request body must be JSON with "token" and "target"');
  }
  const parsed = v.safeParse(AgentSignInRequestSchema, raw);
  if (!parsed.success) {
    throw errors.badRequest('Request body must be JSON with non-empty "token" and "target"');
  }
  const body = parsed.output;

  const claims = await verifyAgentSignInToken(body.token, trust, agentSignInAudience(env));
  const source = { projectId: claims.project_id, userId: claims.user_id };
  const logContext = {
    issuer: trust.issuer,
    sourceProjectId: source.projectId,
    sourceUserId: source.userId,
    sourceTaskId: claims.task_id ?? null,
    jti: claims.jti,
  };

  if (!isAllowedSource(trust, source)) {
    log.warn('agent_sign_in.rejected', {
      ...logContext,
      reason: 'source_not_allowed',
      action: 'rejected',
    });
    throw errors.forbidden('This workload is not allowed to sign in here');
  }

  const user = await findTargetUser(env, body.target);
  if (
    !user ||
    user.id === SYSTEM_USER_ID ||
    user.status === 'system' ||
    !isAllowedTarget(trust, user)
  ) {
    log.warn('agent_sign_in.rejected', {
      ...logContext,
      targetUserId: user?.id ?? null,
      reason: user ? 'target_not_allowed' : 'target_missing',
      action: 'rejected',
    });
    throw errors.forbidden(TARGET_NOT_ALLOWED);
  }

  if (!(await hasEstablishedAdministrator(env))) {
    log.warn('agent_sign_in.rejected', {
      ...logContext,
      targetUserId: user.id,
      reason: 'no_administrator',
      action: 'rejected',
    });
    throw errors.forbidden('Agent sign-in is unavailable until this instance has an administrator');
  }

  // The same approval and status gate as every other sign-in, before anything is recorded.
  const sessionUser = {
    id: user.id,
    email: user.email ?? '',
    name: user.name,
    role: user.role,
    status: user.status,
  };
  await assertUserCanCreateSession(env, sessionUser);

  const nowMs = Date.now();
  const sessionExpiresAtMs = nowMs + trust.sessionTtlSeconds * 1000;
  const claim = await claimAgentSignIn(
    env,
    {
      issuer: trust.issuer,
      jti: claims.jti,
      sourceSubject: claims.sub,
      sourceProjectId: source.projectId,
      sourceUserId: source.userId,
      sourceAgentProfileId: claims.agent_profile_id ?? null,
      sourceTaskId: claims.task_id ?? null,
      sourceWorkspaceId: claims.workspace_id ?? null,
      targetUserId: user.id,
      tokenExpiresAtMs: claims.exp * 1000,
      sessionExpiresAtMs,
    },
    trust.maxSignInsPerHour,
    nowMs
  );
  if (claim.outcome === 'replayed') {
    log.warn('agent_sign_in.rejected', {
      ...logContext,
      targetUserId: user.id,
      reason: 'replayed',
      action: 'rejected',
    });
    throw errors.unauthorized('Workload identity token rejected (replayed)');
  }
  if (claim.outcome === 'rate_limited') {
    log.warn('agent_sign_in.rejected', {
      ...logContext,
      targetUserId: user.id,
      reason: 'rate_limited',
      action: 'rejected',
    });
    throw new RateLimitError(claim.retryAfterSeconds);
  }

  const { response, session } = await createSessionLogin(env, sessionUser, {
    ttlSeconds: trust.sessionTtlSeconds,
  });
  await linkAgentSignInSession(env, claim.id, session.sessionId);
  log.info('agent_sign_in.accepted', {
    ...logContext,
    signInId: claim.id,
    targetUserId: user.id,
    sessionExpiresAt: new Date(sessionExpiresAtMs).toISOString(),
  });
  return response;
}

const agentSignInRoutes = new Hono<{ Bindings: Env }>();

agentSignInRoutes.post(AGENT_SIGN_IN_ROUTE, async (c, next) => {
  const trust = resolveAgentSignInTrust(c.env);
  if (!trust) {
    // Feature off: step aside so the request gets exactly the answer it would get if this
    // route were not mounted at all.
    await next();
    return;
  }
  await rateLimit({
    limit: trust.maxAttemptsPerIpPerHour,
    keyPrefix: 'agent-sign-in',
    useIp: true,
  })(c, async () => {});
  return exchange(c, trust);
});

export { agentSignInRoutes };
