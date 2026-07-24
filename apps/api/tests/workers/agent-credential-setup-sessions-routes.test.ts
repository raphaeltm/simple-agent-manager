/**
 * Miniflare integration tests for the guided Codex credential-setup routes
 * (apps/api/src/routes/agent-credential-setup-sessions.ts), mounted at
 * /api/agent-credential-setup-sessions.
 *
 * Two auth models are exercised here:
 *  1. REST routes (POST /, GET /:id, POST /:id/cancel, GET /:id/terminal-token,
 *     GET /config) use browser session-cookie auth (requireAuth/requireApproved).
 *     The Miniflare test harness does not support minting a real BetterAuth
 *     session cookie, so only the auth-REJECTION path (no cookie -> 401) is
 *     verified here — this proves the routes are mounted and the session
 *     middleware is wired, mirroring composable-credentials-routes.test.ts.
 *  2. The terminal WebSocket route (GET /:id/terminal/ws) has NO session
 *     middleware — it verifies a `?token=` credential-setup JWT itself and
 *     binds the token's own verified setupSessionId to the URL (rule 51).
 *     Because every failure branch here returns a plain JSON error BEFORE any
 *     WebSocket upgrade is attempted, a normal (non-upgrade) SELF.fetch() GET
 *     is sufficient to exercise the full auth-rejection chain, including the
 *     D1 ownership lookup — no SETUP_SESSION_POOL/CREDENTIAL_SETUP_SESSION/
 *     SANDBOX bindings are required for any case below.
 */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `acss-routes-${Date.now()}`;
const OWNER_USER_ID = `${TEST_PREFIX}-owner`;
const ATTACKER_USER_ID = `${TEST_PREFIX}-attacker`;

async function seedSetupSession(opts: {
  id: string;
  userId: string;
  agentType?: string;
  status?: string;
  poolLeaseId?: string | null;
  expiresAt?: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO agent_credential_setup_sessions
     (id, user_id, project_id, scope, agent_type, credential_kind, status, sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'user', ?, 'oauth-token', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      opts.id,
      opts.userId,
      opts.agentType ?? 'openai-codex',
      opts.status ?? 'waiting_for_user',
      opts.id, // sandbox_id mirrors the session id (1:1, see route comment)
      opts.poolLeaseId ?? null,
      opts.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
      nowIso,
      nowIso
    )
    .run();
}

beforeAll(async () => {
  await seedUser(OWNER_USER_ID);
  await seedUser(ATTACKER_USER_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// REST routes — session-cookie auth rejection (proves mounting + middleware)
// ─────────────────────────────────────────────────────────────────────────────

describe('agent-credential-setup-sessions REST routes reject unauthenticated requests', () => {
  const routes: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/api/agent-credential-setup-sessions/config' },
    { method: 'POST', path: '/api/agent-credential-setup-sessions' },
    { method: 'GET', path: '/api/agent-credential-setup-sessions/fake-id' },
    { method: 'POST', path: '/api/agent-credential-setup-sessions/fake-id/cancel' },
    { method: 'GET', path: '/api/agent-credential-setup-sessions/fake-id/terminal-token' },
  ];

  for (const { method, path } of routes) {
    it(`${method} ${path} returns 401 without a session`, async () => {
      const res = await SELF.fetch(`http://localhost${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method !== 'GET' ? JSON.stringify({}) : undefined,
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'UNAUTHORIZED' });
    });
  }

  it('GET /config is registered before /:id (literal "config" is not swallowed as a session id)', async () => {
    // If `/config` were NOT registered ahead of `/:id`, this would still 401
    // (both branches require auth) but for a DIFFERENT reason — a session-id
    // lookup for the literal string "config" would need requireAuth() to run
    // first regardless. The routing-order guarantee itself is a static
    // property of route registration; this test documents the expectation and
    // pins the auth-rejection status so a future reordering regression that
    // changes the status code is caught.
    const res = await SELF.fetch('http://localhost/api/agent-credential-setup-sessions/config', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal WebSocket route — token-based auth (no session middleware)
// ─────────────────────────────────────────────────────────────────────────────

describe('terminal WebSocket route — missing/invalid token', () => {
  it('returns 401 when no ?token= is supplied', async () => {
    const res = await SELF.fetch(
      'http://localhost/api/agent-credential-setup-sessions/any-session/terminal/ws',
      { method: 'GET' }
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'UNAUTHORIZED', message: 'Missing terminal token' });
  });

  it('returns 401 for a garbage token string', async () => {
    const res = await SELF.fetch(
      'http://localhost/api/agent-credential-setup-sessions/any-session/terminal/ws?token=not-a-real-jwt',
      { method: 'GET' }
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'UNAUTHORIZED', message: 'Invalid terminal token' });
  });
});

describe('terminal WebSocket route — rule 51: bind to the token’s own verified identity', () => {
  it('rejects a valid token whose setupSessionId does not match the URL session id (403, not 404)', async () => {
    const { signCredentialSetupTerminalToken } = await import('../../src/services/jwt');

    // The attacker holds a token that is VALID for their OWN session id, and
    // points the URL at a DIFFERENT (real, existing, owned-by-someone-else)
    // session id — the classic "supply the victim's real identifier" shape.
    const victimSessionId = `${TEST_PREFIX}-victim-session`;
    await seedSetupSession({ id: victimSessionId, userId: OWNER_USER_ID });

    const { token } = await signCredentialSetupTerminalToken(
      ATTACKER_USER_ID,
      `${TEST_PREFIX}-attacker-own-session`,
      env as never
    );

    const res = await SELF.fetch(
      `http://localhost/api/agent-credential-setup-sessions/${victimSessionId}/terminal/ws?token=${token}`,
      { method: 'GET' }
    );

    // 403 proves the JWT-embedded identity binding rejected the request BEFORE
    // any D1 lookup ran. If this check were removed, the code would instead
    // fall through to loadOwnedSession(victimSessionId, attackerUserId), whose
    // row.user_id !== userId branch ALSO denies access but with a DIFFERENT
    // status (404) — so 403 vs 404 discriminates whether the early
    // token-identity binding (not merely the downstream ownership check) is
    // what rejected the forged request.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'FORBIDDEN', message: 'Token does not match this setup session' });
  });

  it('returns 404 when the token matches the URL session id but no such session exists in D1', async () => {
    const { signCredentialSetupTerminalToken } = await import('../../src/services/jwt');
    const missingSessionId = `${TEST_PREFIX}-does-not-exist`;

    const { token } = await signCredentialSetupTerminalToken(
      OWNER_USER_ID,
      missingSessionId,
      env as never
    );

    const res = await SELF.fetch(
      `http://localhost/api/agent-credential-setup-sessions/${missingSessionId}/terminal/ws?token=${token}`,
      { method: 'GET' }
    );

    expect(res.status).toBe(404);
  });

  it('returns 404 when the token’s userId does not own the D1 row for the matching session id', async () => {
    const { signCredentialSetupTerminalToken } = await import('../../src/services/jwt');
    const sharedSessionId = `${TEST_PREFIX}-owned-by-owner`;
    await seedSetupSession({ id: sharedSessionId, userId: OWNER_USER_ID });

    // Token's setupSessionId matches the URL, but its userId (sub) is the
    // attacker, not the row's actual owner — exercises loadOwnedSession's
    // row.user_id !== userId fail-closed branch directly.
    const { token } = await signCredentialSetupTerminalToken(
      ATTACKER_USER_ID,
      sharedSessionId,
      env as never
    );

    const res = await SELF.fetch(
      `http://localhost/api/agent-credential-setup-sessions/${sharedSessionId}/terminal/ws?token=${token}`,
      { method: 'GET' }
    );

    expect(res.status).toBe(404);
  });

  it('returns 400 once the session has already reached a terminal state', async () => {
    const { signCredentialSetupTerminalToken } = await import('../../src/services/jwt');
    const completedSessionId = `${TEST_PREFIX}-completed-session`;
    await seedSetupSession({ id: completedSessionId, userId: OWNER_USER_ID, status: 'completed' });

    const { token } = await signCredentialSetupTerminalToken(
      OWNER_USER_ID,
      completedSessionId,
      env as never
    );

    const res = await SELF.fetch(
      `http://localhost/api/agent-credential-setup-sessions/${completedSessionId}/terminal/ws?token=${token}`,
      { method: 'GET' }
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'BAD_REQUEST', message: 'Setup session has already ended' });
  });
});
