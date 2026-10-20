/**
 * Signup-approval gate, through the real worker.
 *
 * Every request goes through `SELF` (the exported worker with its real route mounting), carries a
 * real BetterAuth session cookie, and reads the real `signup.requireApproval` platform setting
 * written by `setSignupApprovalConfig`. A route that applies only `requireAuth()` therefore lets a
 * pending account through here exactly as it would in production (`.claude/rules/62`;
 * `apps/api/.claude/rules/06`: auth routing tests go through the combined app).
 *
 * The pending account is a project maintainer and has a valid session, so the only thing that can
 * reject it is the approval gate. `GET /api/auth/me` returning 200 for the same cookie is the
 * liveness check that the 403s below are the gate, not a broken session.
 */
import { createExecutionContext, env, runInDurableObject, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { ulid } from '../../src/lib/ulid';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { projectAgentRoutes } from '../../src/routes/project-agent';
import {
  setSignupApprovalConfig,
  SIGNUP_APPROVAL_SETTING_KEY,
} from '../../src/services/signup-approval';
import {
  seedInstallation,
  seedProject,
  seedSignedInUser,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const API = `https://api.${testEnv.BASE_DOMAIN}`;
const RUN = `approval-gate-${Date.now()}`;
const PENDING_USER_ID = `${RUN}-pending`;
const APPROVED_USER_ID = `${RUN}-approved`;
const PROJECT_ID = `${RUN}-project`;

interface Probe {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

let pendingCookie: string;
let approvedCookie: string;

function send(probe: Probe, cookie: string): Promise<Response> {
  return SELF.fetch(`${API}${probe.path}`, {
    method: probe.method,
    headers: {
      Cookie: cookie,
      ...(probe.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: probe.body ? JSON.stringify(probe.body) : undefined,
  });
}

async function expectApprovalRequired(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ error: 'APPROVAL_REQUIRED' });
}

async function setApprovalRequired(requireApproval: boolean): Promise<void> {
  await setSignupApprovalConfig(testEnv, { requireApproval, updatedBy: APPROVED_USER_ID });
}

const SAM_ROUTES: Probe[] = [
  { method: 'POST', path: '/api/sam/chat', body: { message: 'Spend the platform budget' } },
  { method: 'GET', path: '/api/sam/conversations' },
  { method: 'GET', path: '/api/sam/conversations/conversation-1/messages' },
  { method: 'GET', path: '/api/sam/search?query=budget' },
  { method: 'GET', path: '/api/sam/settings' },
  { method: 'PATCH', path: '/api/sam/settings', body: { enabled: true } },
  { method: 'GET', path: '/api/sam/turns' },
  {
    method: 'POST',
    path: '/api/sam/turns',
    body: { requestKey: 'pending', message: 'Spend budget' },
  },
  { method: 'POST', path: '/api/sam/fork', body: {} },
  { method: 'POST', path: '/api/sam/turns/turn-1/cancel', body: {} },
  { method: 'POST', path: '/api/sam/actions/action-1/confirm', body: { approved: true } },
  { method: 'POST', path: '/api/sam/actions/action-1/reconcile', body: {} },
  { method: 'POST', path: '/api/sam/updates/action-1/seen', body: {} },
];

const PROJECT_AGENT_ROUTES: Probe[] = [
  {
    method: 'POST',
    path: `/api/projects/${PROJECT_ID}/agent/chat`,
    body: { message: 'Spend the platform budget' },
  },
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/agent/conversations` },
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/agent/conversations/c1/messages` },
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/agent/search?query=budget` },
];

const API_TOKEN_ROUTES: Probe[] = [
  { method: 'GET', path: '/api/auth/api-tokens' },
  { method: 'POST', path: '/api/auth/api-tokens', body: { name: 'Minted while pending' } },
  { method: 'DELETE', path: '/api/auth/api-tokens/token-1' },
];

/**
 * Routers that declare no auth of their own and inherit `requireAuth(), requireApproved()` from
 * the `/api/projects/*` wildcard in `projectsRoutes`. Kept as-is by the audit; pinned here so a
 * mount-order change cannot quietly open them to pending accounts.
 */
const INHERITED_PROJECT_ROUTES: Probe[] = [
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/comments` },
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/event-channels` },
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/event-subscriptions` },
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/schedules` },
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/standing-watches` },
  { method: 'GET', path: `/api/projects/${PROJECT_ID}/library/file-1/comments` },
];

beforeAll(async () => {
  const installationId = `${RUN}-installation`;
  await seedUser(APPROVED_USER_ID, { githubId: `${RUN}-approved-gh` });
  await seedUser(PENDING_USER_ID, { githubId: `${RUN}-pending-gh` });
  await seedInstallation(installationId, APPROVED_USER_ID, {
    installationIdValue: `${RUN}-external-installation`,
  });
  await seedProject(PROJECT_ID, APPROVED_USER_ID, installationId);
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, 'maintainer', 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(PROJECT_ID, PENDING_USER_ID, APPROVED_USER_ID)
    .run();

  approvedCookie = await seedSignedInUser(APPROVED_USER_ID);
  pendingCookie = await seedSignedInUser(PENDING_USER_ID, { status: 'pending' });
  await setApprovalRequired(true);
});

// `signup.requireApproval` is one global row in the D1 shared by every workers test file, so
// remove it again: no other file expects approval to be on.
afterAll(async () => {
  await testEnv.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?')
    .bind(SIGNUP_APPROVAL_SETTING_KEY)
    .run();
});

describe('pending accounts are refused before any handler runs', () => {
  it.each(SAM_ROUTES)('$method $path (SAM agent)', async (probe) => {
    await expectApprovalRequired(await send(probe, pendingCookie));
  });

  it.each(PROJECT_AGENT_ROUTES)('$method $path (project agent)', async (probe) => {
    await expectApprovalRequired(await send(probe, pendingCookie));
  });

  it.each(API_TOKEN_ROUTES)('$method $path (API token management)', async (probe) => {
    await expectApprovalRequired(await send(probe, pendingCookie));
  });

  it.each(INHERITED_PROJECT_ROUTES)('$method $path (inherited project gate)', async (probe) => {
    await expectApprovalRequired(await send(probe, pendingCookie));
  });

  it('records no SAM messages, turns or actions for the pending account', async () => {
    await send(SAM_ROUTES[0]!, pendingCookie);
    const samSession = testEnv.SAM_SESSION.get(testEnv.SAM_SESSION.idFromName(PENDING_USER_ID));
    const count = await runInDurableObject(
      samSession,
      async (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            'SELECT (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM operator_turns) + (SELECT COUNT(*) FROM operator_actions) AS count'
          )
          .one().count
    );
    expect(count).toBe(0);
    const disabled = await samSession.fetch('https://sam-session/conversations');
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toMatchObject({
      error: 'sam_disabled',
      rejectedBeforeEffects: true,
    });
  });

  it('does not mint an API token for the pending account', async () => {
    await send(API_TOKEN_ROUTES[1]!, pendingCookie);
    const tokens = await drizzle(testEnv.DATABASE, { schema })
      .select({ id: schema.apiTokens.id })
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.userId, PENDING_USER_ID))
      .all();
    expect(tokens).toEqual([]);
  });
});

describe('what a pending account may still reach', () => {
  it('reads its own account and approval status', async () => {
    const response = await SELF.fetch(`${API}/api/auth/me`, { headers: { Cookie: pendingCookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: PENDING_USER_ID,
      status: 'pending',
    });
  });

  it('reaches the trial-claim handler, which completes signup for its own trial', async () => {
    const response = await send({ method: 'POST', path: '/api/trial/claim' }, pendingCookie);
    // The handler ran: it rejected the missing claim cookie, not the account.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Missing trial claim cookie',
    });
  });

  it.each([SAM_ROUTES[4]!, PROJECT_AGENT_ROUTES[1]!, API_TOKEN_ROUTES[0]!])(
    'passes $method $path once signup approval is turned off (control)',
    async (probe) => {
      await setApprovalRequired(false);
      try {
        expect((await send(probe, pendingCookie)).status).toBe(200);
      } finally {
        await setApprovalRequired(true);
      }
    }
  );
});

describe('approved accounts still reach the handlers', () => {
  it('SAM agent: requires opt-in, then lists conversations and validates chat input', async () => {
    const disabled = await send(SAM_ROUTES[1]!, approvedCookie);
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toMatchObject({ error: 'sam_disabled' });
    const enabled = await send(SAM_ROUTES[5]!, approvedCookie);
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({ enabled: true });
    const listed = await send(SAM_ROUTES[1]!, approvedCookie);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      conversations: [{ title: 'SAM', type: 'human' }],
    });

    // A blank message is rejected by the handler itself, so no model call is made.
    const chat = await send(
      { method: 'POST', path: '/api/sam/chat', body: { message: ' ' } },
      approvedCookie
    );
    expect(chat.status).toBe(400);
    await expect(chat.json()).resolves.toEqual({ error: 'Message is required' });
  });

  it('project agent: lists conversations and validates chat input', async () => {
    const listed = await send(PROJECT_AGENT_ROUTES[1]!, approvedCookie);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ conversations: [] });

    const chat = await send(
      { method: 'POST', path: `/api/projects/${PROJECT_ID}/agent/chat`, body: { message: ' ' } },
      approvedCookie
    );
    expect(chat.status).toBe(400);
    await expect(chat.json()).resolves.toEqual({ error: 'Message is required' });
  });

  it('API tokens: creates, lists and revokes its own token', async () => {
    const created = await send(
      { method: 'POST', path: '/api/auth/api-tokens', body: { name: 'Approved laptop' } },
      approvedCookie
    );
    expect(created.status).toBe(201);
    const { id, token } = await created.json<{ id: string; token: string }>();
    expect(token).toMatch(/^sam_pat_/);

    const listed = await send({ method: 'GET', path: '/api/auth/api-tokens' }, approvedCookie);
    expect(listed.status).toBe(200);
    expect((await listed.json<Array<{ id: string }>>()).map((row) => row.id)).toContain(id);

    const revoked = await send(
      { method: 'DELETE', path: `/api/auth/api-tokens/${id}` },
      approvedCookie
    );
    expect(revoked.status).toBe(200);
  });
});

/**
 * Through `SELF`, the project-agent routes are also covered by the `/api/projects/*` wildcard
 * (mounted first), so the tests above stay green even if the router's own `requireApproved()` is
 * deleted. Mounting the real router alone is what proves its own guard.
 */
describe('project-agent router enforces approval on its own', () => {
  function routerAlone(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/projects/:projectId/agent', projectAgentRoutes);
    return app;
  }

  function request(probe: Probe, cookie: string): Request {
    return new Request(`${API}${probe.path}`, {
      method: probe.method,
      headers: { Cookie: cookie, ...(probe.body ? { 'Content-Type': 'application/json' } : {}) },
      body: probe.body ? JSON.stringify(probe.body) : undefined,
    });
  }

  it.each(PROJECT_AGENT_ROUTES)('refuses a pending account: $method $path', async (probe) => {
    const response = await routerAlone().fetch(
      request(probe, pendingCookie),
      testEnv,
      createExecutionContext()
    );
    await expectApprovalRequired(response);
  });

  it.each(PROJECT_AGENT_ROUTES)('serves an approved account: $method $path', async (probe) => {
    // Blank chat input proves handler access without spending LLM budget.
    const safeProbe = probe.method === 'POST' ? { ...probe, body: { message: ' ' } } : probe;
    const response = await routerAlone().fetch(
      request(safeProbe, approvedCookie),
      testEnv,
      createExecutionContext()
    );
    expect(response.status).toBe(probe.method === 'POST' ? 400 : 200);
    if (probe.method === 'POST') {
      await expect(response.json()).resolves.toEqual({ error: 'Message is required' });
    }
  });
});

// A pending account can already own resources provisioned while approval was disabled.
// Seed that persisted state; a stopped workspace proves authorization without a live VM.
describe('workspace cookie access follows runtime approval changes', () => {
  it('blocks an existing pending owner immediately when approval is enabled', async () => {
    const workspaceId = ulid();
    await setApprovalRequired(false);
    try {
      await seedWorkspace(workspaceId, null, PENDING_USER_ID, { status: 'stopped' });
      const url = `https://ws-${workspaceId.toLowerCase()}.${testEnv.BASE_DOMAIN}/terminal`;
      const requestWorkspace = () => SELF.fetch(url, { headers: { Cookie: pendingCookie } });
      const before = await requestWorkspace();
      expect(before.status).toBe(503);
      await expect(before.json()).resolves.toMatchObject({ error: 'NOT_READY' });

      await setApprovalRequired(true);
      await expectApprovalRequired(await requestWorkspace());

      await setApprovalRequired(false);
      expect((await requestWorkspace()).status).toBe(503);
    } finally {
      await setApprovalRequired(true);
    }
  });

  it('allows an approved owner with approval enabled', async () => {
    const workspaceId = ulid();
    await seedWorkspace(workspaceId, null, APPROVED_USER_ID, { status: 'stopped' });
    const response = await SELF.fetch(
      `https://ws-${workspaceId.toLowerCase()}.${testEnv.BASE_DOMAIN}/terminal`,
      { headers: { Cookie: approvedCookie } }
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'NOT_READY' });
  });
});
