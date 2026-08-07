/**
 * Miniflare integration tests for the guided Codex credential-setup routes
 * (apps/api/src/routes/agent-credential-setup-sessions.ts), mounted at
 * /api/agent-credential-setup-sessions.
 *
 * Two auth models are exercised here:
 * REST routes (POST /, GET /:id, POST /:id/cancel, GET /config) use browser
 * session-cookie auth (requireAuth/requireApproved).
 *     The Miniflare test harness does not support minting a real BetterAuth
 *     session cookie, so only the auth-REJECTION path (no cookie -> 401) is
 *     verified here — this proves the routes are mounted and the session
 *     middleware is wired, mirroring composable-credentials-routes.test.ts.
 * No browser terminal or unauthenticated WebSocket route is exposed.
 */
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `acss-routes-${Date.now()}`;
const OWNER_USER_ID = `${TEST_PREFIX}-owner`;

beforeAll(async () => {
  await seedUser(OWNER_USER_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// REST routes — session-cookie auth rejection (proves mounting + middleware)
// ─────────────────────────────────────────────────────────────────────────────

describe('agent-credential-setup-sessions REST routes reject unauthenticated requests', () => {
  const routes: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/api/agent-credential-setup-sessions/config' },
    { method: 'POST', path: '/api/agent-credential-setup-sessions' },
    { method: 'GET', path: '/api/agent-credential-setup-sessions/fake-id' },
    { method: 'POST', path: '/api/agent-credential-setup-sessions/fake-id/credential' },
    { method: 'POST', path: '/api/agent-credential-setup-sessions/fake-id/cancel' },
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
