/**
 * Guided agent-credential setup sessions (native provider login).
 *
 * User-facing flow for connecting subscription/OAuth-backed coding agents
 * without exposing terminal setup mechanics:
 *   POST   /                      create a setup session (leases a sandbox slot)
 *   GET    /:id                   poll lifecycle status
 *   POST   /:id/cancel            cancel + tear down
 *
 * AUTH: all routes use browser session-cookie auth (requireAuth/requireApproved)
 * and perform per-session ownership checks before reading authoritative DO state.
 *
 * Availability is derived from the required runtime bindings. No deployment
 * environment variable is needed to turn this product flow on.
 */
import { type AgentType, getAgentDefinition, isValidAgentType } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator } from '../schemas';
import {
  ACTIVE_SETUP_STATUSES,
  getSetupSessionCapturePollMs,
  getSetupSessionTtlMs,
  isTerminalSetupStatus,
} from '../services/credential-setup-config';
import {
  cancelSetupSession,
  getSetupSessionState,
  startSetupSession,
  submitSetupSessionVerificationCode,
} from '../services/credential-setup-session';
import { leaseSetupSlot, releaseSetupSlot } from '../services/setup-session-pool';

const agentCredentialSetupSessionsRoutes = new Hono<{ Bindings: Env }>();

const DEFAULT_SETUP_AGENT_TYPE = 'openai-codex';
const SUPPORTED_SETUP_AGENT_TYPES = ['openai-codex', 'claude-code'] as const;
type SupportedSetupAgentType = (typeof SUPPORTED_SETUP_AGENT_TYPES)[number];
const SETUP_CREDENTIAL_KIND = 'oauth-token';
const ACTIVE_STATUS_PLACEHOLDERS = ACTIVE_SETUP_STATUSES.map(() => '?').join(', ');
const MAX_SUBMITTED_CLAUDE_CODE_LENGTH = 1024;

const SubmitVerificationCodeSchema = v.object({
  code: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_SUBMITTED_CLAUDE_CODE_LENGTH)),
});

function isSupportedSetupAgentType(agentType: AgentType): agentType is SupportedSetupAgentType {
  return SUPPORTED_SETUP_AGENT_TYPES.includes(agentType as SupportedSetupAgentType);
}

/**
 * Per-session isolated provider config dir inside the sandbox (deterministic from
 * id). Codex uses CODEX_HOME; Claude Code uses CLAUDE_CONFIG_DIR.
 */
function setupHomeFor(agentType: SupportedSetupAgentType, sessionId: string): string {
  return agentType === 'claude-code'
    ? `/root/.claude-setup-${sessionId}`
    : `/root/.codex-setup-${sessionId}`;
}

interface SetupSessionD1Row {
  id: string;
  user_id: string;
  project_id: string | null;
  agent_type: string;
  status: string;
  sandbox_id: string;
  expires_at: string;
  error_code: string | null;
  error_message: string | null;
}

function guidedSetupAvailable(env: Env): boolean {
  return !!env.SANDBOX && !!env.CREDENTIAL_SETUP_SESSION && !!env.SETUP_SESSION_POOL;
}

async function loadOwnedSession(
  env: Env,
  sessionId: string,
  userId: string
): Promise<SetupSessionD1Row> {
  const row = await env.DATABASE.prepare(
    `SELECT id, user_id, project_id, agent_type, status, sandbox_id, expires_at, error_code, error_message
     FROM agent_credential_setup_sessions WHERE id = ? LIMIT 1`
  )
    .bind(sessionId)
    .first<SetupSessionD1Row>();
  // Fail closed on missing OR cross-user access — never leak another user's row.
  if (!row || row.user_id !== userId) {
    throw errors.notFound('Setup session');
  }
  return row;
}

// -----------------------------------------------------------------------------
// GET /config — whether the required guided-flow runtime bindings are available.
// Registered before /:id so "config" is not captured as a session id.
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.get('/config', requireAuth(), requireApproved(), (c) => {
  const enabled = guidedSetupAvailable(c.env);
  return c.json({
    enabled,
    agentType: DEFAULT_SETUP_AGENT_TYPE,
    agentTypes: SUPPORTED_SETUP_AGENT_TYPES,
  });
});

// -----------------------------------------------------------------------------
// POST / — create a setup session
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.post('/', requireAuth(), requireApproved(), async (c) => {
  if (!guidedSetupAvailable(c.env)) {
    throw errors.notFound('Guided credential setup is not enabled');
  }

  const userId = getUserId(c);
  const body = await c.req
    .json<{ agentType?: string }>()
    .catch(() => ({}) as { agentType?: string });
  const requestedAgentType = body.agentType ?? DEFAULT_SETUP_AGENT_TYPE;
  if (!isValidAgentType(requestedAgentType) || !isSupportedSetupAgentType(requestedAgentType)) {
    throw errors.badRequest(
      `Guided setup currently supports only ${SUPPORTED_SETUP_AGENT_TYPES.join(', ')}`
    );
  }
  const agentType = requestedAgentType;
  const agentDef = getAgentDefinition(agentType);
  if (!agentDef) {
    throw errors.badRequest(`Unknown agent type: ${agentType}`);
  }

  // Friendly pre-check: one active setup session per (user, agentType). The
  // partial unique index is the atomic backstop below.
  const existingActive = await c.env.DATABASE.prepare(
    `SELECT id FROM agent_credential_setup_sessions
     WHERE user_id = ? AND agent_type = ? AND status IN (${ACTIVE_STATUS_PLACEHOLDERS}) LIMIT 1`
  )
    .bind(userId, agentType, ...ACTIVE_SETUP_STATUSES)
    .first<{ id: string }>();
  if (existingActive) {
    const row = await loadOwnedSession(c.env, existingActive.id, userId);
    const state = await getSetupSessionState(c.env, row.id);
    return c.json({
      id: row.id,
      status: state?.status ?? row.status,
      agentType: row.agent_type,
      expiresAt: row.expires_at,
      verificationUrl: state?.verificationUrl ?? null,
      userCode: state?.userCode ?? null,
      errorCode: state?.errorCode ?? row.error_code,
      errorMessage: state?.errorMessage ?? row.error_message,
    });
  }

  const sessionId = ulid();
  const sandboxId = sessionId; // 1:1, never shared across users
  const ttlMs = getSetupSessionTtlMs(c.env);
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + ttlMs).toISOString();

  const lease = await leaseSetupSlot(c.env, sessionId);
  if (!lease.granted || !lease.leaseId) {
    return c.json(
      {
        status: 'no_capacity',
        message: 'All guided setup slots are in use. Please try again in a minute.',
      },
      202
    );
  }
  const leaseId = lease.leaseId;

  // Reserve the row (atomic one-active enforcement) before the slow sandbox boot.
  try {
    await c.env.DATABASE.prepare(
      `INSERT INTO agent_credential_setup_sessions
       (id, user_id, project_id, scope, agent_type, credential_kind, status, sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
       VALUES (?, ?, NULL, 'user', ?, ?, 'provisioning', ?, ?, ?, ?, ?)`
    )
      .bind(
        sessionId,
        userId,
        agentType,
        SETUP_CREDENTIAL_KIND,
        sandboxId,
        leaseId,
        expiresAtIso,
        nowIso,
        nowIso
      )
      .run();
  } catch (err) {
    await releaseSetupSlot(c.env, leaseId);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE') || msg.toLowerCase().includes('constraint')) {
      return c.json(
        { error: 'active_session_exists', message: 'A setup session is already in progress' },
        409
      );
    }
    throw err;
  }

  try {
    const state = await startSetupSession(c.env, {
      id: sessionId,
      userId,
      projectId: null,
      scope: 'user',
      agentType,
      credentialKind: SETUP_CREDENTIAL_KIND,
      provider: agentDef.provider,
      agentName: agentDef.name,
      poolLeaseId: leaseId,
      setupHome: setupHomeFor(agentType, sessionId),
      ttlMs,
      capturePollMs: getSetupSessionCapturePollMs(c.env),
    });
    return c.json(
      {
        id: state.id,
        status: state.status,
        agentType,
        expiresAt: state.expiresAt,
        verificationUrl: state.verificationUrl,
        userCode: state.userCode,
      },
      201
    );
  } catch (err) {
    // A provision failure self-tears-down inside the DO, but if the create() RPC
    // itself failed the lease + D1 row would linger until the TTL sweep — release
    // them now so a rare DO error doesn't burn a scarce slot for ~20 min.
    await releaseSetupSlot(c.env, leaseId).catch(() => {});
    await c.env.DATABASE.prepare(
      `UPDATE agent_credential_setup_sessions
       SET status = 'failed', error_code = 'start_failed', completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'provisioning'`
    )
      .bind(nowIso, nowIso, sessionId)
      .run()
      .catch(() => {});
    log.error('credential_setup.start_failed', {
      sessionId,
      agentType,
      error: err instanceof Error ? err.message : String(err),
    });
    throw errors.internal('Failed to start guided setup session');
  }
});

// -----------------------------------------------------------------------------
// GET /:id — poll status (D1 is kept current by the DO)
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.get('/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const row = await loadOwnedSession(c.env, c.req.param('id'), userId);
  const state = await getSetupSessionState(c.env, row.id);
  return c.json({
    id: row.id,
    status: state?.status ?? row.status,
    agentType: row.agent_type,
    expiresAt: row.expires_at,
    verificationUrl: state?.verificationUrl ?? null,
    userCode: state?.userCode ?? null,
    errorCode: state?.errorCode ?? row.error_code,
    errorMessage: state?.errorMessage ?? row.error_message,
  });
});

// -----------------------------------------------------------------------------
// POST /:id/verification-code — forward Claude's browser code to the CLI
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.post(
  '/:id/verification-code',
  requireAuth(),
  requireApproved(),
  jsonValidator(SubmitVerificationCodeSchema),
  async (c) => {
    const userId = getUserId(c);
    const row = await loadOwnedSession(c.env, c.req.param('id'), userId);
    if (row.agent_type !== 'claude-code') {
      throw errors.badRequest('Verification codes are only available for Claude Code setup');
    }
    if (isTerminalSetupStatus(row.status)) {
      throw errors.conflict('Setup session is no longer active');
    }

    const state = await submitSetupSessionVerificationCode(c.env, row.id, c.req.valid('json').code);
    return c.json({
      id: row.id,
      status: state.status,
      agentType: row.agent_type,
      expiresAt: row.expires_at,
      verificationUrl: state.verificationUrl,
      userCode: state.userCode,
      errorCode: state.errorCode,
      errorMessage: state.errorMessage,
    });
  }
);

// -----------------------------------------------------------------------------
// POST /:id/cancel — cancel + tear down
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.post(
  '/:id/cancel',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const userId = getUserId(c);
    const row = await loadOwnedSession(c.env, c.req.param('id'), userId);
    const state = await cancelSetupSession(c.env, row.id);
    return c.json({ id: row.id, status: state.status });
  }
);

export { agentCredentialSetupSessionsRoutes };
