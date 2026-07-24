/**
 * Guided agent-credential setup sessions (Cloudflare Sandbox terminal login).
 *
 * User-facing flow for connecting an OpenAI Codex (ChatGPT subscription) account
 * without manual auth.json paste:
 *   POST   /                      create a setup session (leases a sandbox slot)
 *   GET    /:id                   poll lifecycle status
 *   POST   /:id/cancel            cancel + tear down
 *   GET    /:id/terminal-token    mint a short-lived WS token for the terminal
 *   GET    /:id/terminal/ws       browser terminal WebSocket -> sandbox PTY
 *
 * AUTH: REST routes use browser session-cookie auth (requireAuth/requireApproved)
 * with per-route ownership checks. The terminal WS route has NO session
 * middleware — WebSocket upgrades cannot attach cookies reliably, so it verifies
 * a `?token=` credential-setup JWT and asserts the bound setupSessionId matches
 * the URL (rules 34/51: bind to the token's own verified identity, fail closed).
 * This router MUST NOT use a wildcard `.use()` or the WS route would be rejected.
 *
 * Gate: default-OFF (`CODEX_SETUP_TERMINAL_ENABLED`) AND requires the Sandbox
 * runtime (`SANDBOX_ENABLED`).
 */
import { getAgentDefinition, isValidAgentType } from '@simple-agent-manager/shared';
import { Hono } from 'hono';

import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { requireApproved, requireAuth, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  ACTIVE_SETUP_STATUSES,
  getSetupSessionCapturePollMs,
  getSetupSessionTtlMs,
  isCodexSetupTerminalEnabled,
  isTerminalSetupStatus,
} from '../services/credential-setup-config';
import {
  cancelSetupSession,
  startSetupSession,
} from '../services/credential-setup-session';
import { getSandboxInstance, requireSandbox } from '../services/sandbox';
import { leaseSetupSlot, releaseSetupSlot } from '../services/setup-session-pool';
import { signCredentialSetupTerminalToken, verifyCredentialSetupTerminalToken } from '../services/jwt';

const agentCredentialSetupSessionsRoutes = new Hono<{ Bindings: Env }>();

/** v1 supports Codex only (see idea 01KRPWSZWFT0Y06DH9VEXC7CYQ 2026-07-23 BUILD DECISION). */
const SUPPORTED_AGENT_TYPE = 'openai-codex';
const SETUP_CREDENTIAL_KIND = 'oauth-token';
const ACTIVE_STATUS_PLACEHOLDERS = ACTIVE_SETUP_STATUSES.map(() => '?').join(', ');

/** Per-session isolated CODEX_HOME inside the sandbox (deterministic from id). */
function codexHomeFor(sessionId: string): string {
  return `/tmp/codex-setup-${sessionId}`;
}

/** The command the browser terminal auto-runs to start the device-auth login. */
function codexLoginCommand(sessionId: string): string {
  return `CODEX_HOME=${codexHomeFor(sessionId)} codex login --device-auth`;
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

function clampDimension(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1000, Math.max(1, parsed));
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
    throw errors.notFound('Setup session not found');
  }
  return row;
}

// -----------------------------------------------------------------------------
// POST / — create a setup session
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.post('/', requireAuth(), requireApproved(), async (c) => {
  if (!isCodexSetupTerminalEnabled(c.env)) {
    throw errors.notFound('Guided credential setup is not enabled');
  }
  requireSandbox(c.env); // throws if SANDBOX_ENABLED !== 'true' or binding missing

  const userId = getUserId(c);
  const body = await c.req.json<{ agentType?: string }>().catch(() => ({}) as { agentType?: string });
  const agentType = body.agentType ?? SUPPORTED_AGENT_TYPE;
  if (!isValidAgentType(agentType) || agentType !== SUPPORTED_AGENT_TYPE) {
    throw errors.badRequest(`Guided setup currently supports only ${SUPPORTED_AGENT_TYPE}`);
  }
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
    return c.json(
      { error: 'active_session_exists', message: 'A setup session is already in progress' },
      409
    );
  }

  const sessionId = ulid();
  const sandboxId = sessionId; // 1:1, never shared across users
  const ttlMs = getSetupSessionTtlMs(c.env);
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + ttlMs).toISOString();

  const lease = await leaseSetupSlot(c.env, sessionId);
  if (!lease.granted) {
    return c.json(
      {
        status: 'no_capacity',
        message: 'All guided setup slots are in use. Please try again in a minute.',
      },
      202
    );
  }

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
        lease.leaseId,
        expiresAtIso,
        nowIso,
        nowIso
      )
      .run();
  } catch (err) {
    await releaseSetupSlot(c.env, lease.leaseId);
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
      poolLeaseId: lease.leaseId!,
      codexHome: codexHomeFor(sessionId),
      ttlMs,
      capturePollMs: getSetupSessionCapturePollMs(c.env),
    });
    return c.json(
      {
        id: state.id,
        status: state.status,
        agentType,
        expiresAt: state.expiresAt,
        loginCommand: codexLoginCommand(sessionId),
      },
      201
    );
  } catch (err) {
    // The DO tears itself down (releases lease, marks D1 failed) on provision
    // errors; surface a clear failure.
    throw errors.internal(
      `Failed to start setup session: ${err instanceof Error ? err.message : String(err)}`
    );
  }
});

// -----------------------------------------------------------------------------
// GET /:id — poll status (D1 is kept current by the DO)
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.get('/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const row = await loadOwnedSession(c.env, c.req.param('id'), userId);
  return c.json({
    id: row.id,
    status: row.status,
    agentType: row.agent_type,
    expiresAt: row.expires_at,
    loginCommand: codexLoginCommand(row.id),
    errorCode: row.error_code,
    errorMessage: row.error_message,
  });
});

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

// -----------------------------------------------------------------------------
// GET /:id/terminal-token — mint a short-lived WS token for this session
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.get(
  '/:id/terminal-token',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const userId = getUserId(c);
    const row = await loadOwnedSession(c.env, c.req.param('id'), userId);
    if (isTerminalSetupStatus(row.status)) {
      throw errors.badRequest('Setup session has already ended');
    }
    const token = await signCredentialSetupTerminalToken(userId, row.id, c.env);
    return c.json({ token });
  }
);

// -----------------------------------------------------------------------------
// GET /:id/terminal/ws — browser terminal WebSocket -> sandbox PTY
// NO session middleware: verifies the ?token= credential-setup JWT itself.
// -----------------------------------------------------------------------------
agentCredentialSetupSessionsRoutes.get('/:id/terminal/ws', async (c) => {
  const sessionId = c.req.param('id');
  const token = c.req.query('token');
  if (!token) {
    throw errors.unauthorized('Missing terminal token');
  }

  let payload: { userId: string; setupSessionId: string };
  try {
    payload = await verifyCredentialSetupTerminalToken(token, c.env);
  } catch {
    throw errors.unauthorized('Invalid terminal token');
  }
  // Bind the token's own verified identity to the URL session (rule 51).
  if (payload.setupSessionId !== sessionId) {
    throw errors.forbidden('Token does not match this setup session');
  }

  const row = await loadOwnedSession(c.env, sessionId, payload.userId);
  if (isTerminalSetupStatus(row.status)) {
    throw errors.badRequest('Setup session has already ended');
  }

  const cols = clampDimension(c.req.query('cols'), 80);
  const rows = clampDimension(c.req.query('rows'), 24);

  const sandbox = await getSandboxInstance(c.env, row.sandbox_id);
  // terminal() lives on an ExecutionSession. Create one bound to this session's
  // CODEX_HOME; sessions share the container filesystem with the DO's
  // provisioning/capture calls (same sandboxId == same container), so the
  // auth.json codex writes in this shell is readable server-side by the DO.
  const session = await sandbox.createSession({
    name: `codex-login-${sessionId}`,
    env: { CODEX_HOME: codexHomeFor(sessionId) },
  });
  // Sandbox SDK owns the 101 upgrade; return its Response verbatim.
  return session.terminal(c.req.raw, { cols, rows });
});

export { agentCredentialSetupSessionsRoutes };
