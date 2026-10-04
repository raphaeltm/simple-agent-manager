/**
 * Workspace callback token renewal, exercised through the real Worker
 * (`SELF.fetch` → index.ts → workspacesRoutes) with real D1 rows and real RS256 tokens.
 *
 * A workspace callback token is minted at create/restore and lives CALLBACK_TOKEN_EXPIRY_MS
 * (24h). Production workspaces awake longer than that got 401 on every snapshot, git-token
 * and resource-history callback. These tests drive the renewal route the way the VM agent
 * does: an aged-but-valid workspace token plus the hosting node's token.
 *
 * Tokens are signed with the Worker's real key and the exact claim set `signCallbackToken`
 * produces, but with issue/expiry times shifted into the past, which is how the tests cross
 * the 50% refresh threshold and the 24h expiry without waiting.
 */
import { env, SELF } from 'cloudflare:test';
import { decodeJwt, importPKCS8, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM } from '../../src/services/callback-token-claims';
import {
  signCallbackToken,
  signNodeCallbackToken,
  verifyCallbackToken,
} from '../../src/services/jwt';
import { hibernateAgentSessionOnNode } from '../../src/services/node-agent-session-snapshots';
import { mintWorkspaceCallbackTokenForNodeDelivery } from '../../src/services/workspace-callback-token-renewal';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const PREFIX = `cbrenew-${Date.now()}`;
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

const USER_ID = `${PREFIX}-user`;
const OTHER_USER_ID = `${PREFIX}-other-user`;

const NODE_ID = `${PREFIX}-node`;
const OTHER_NODE_ID = `${PREFIX}-node-2`;
const OTHER_OWNER_NODE_ID = `${PREFIX}-node-other-owner`;
const STOPPED_NODE_ID = `${PREFIX}-node-stopped`;
const INSTANT_NODE_ID = `${PREFIX}-node-instant`;

const WS_ACTIVE = `${PREFIX}-ws-active`;
const WS_CREATING = `${PREFIX}-ws-creating`;
const WS_ON_OTHER_NODE = `${PREFIX}-ws-other-node`;
const WS_DELETED = `${PREFIX}-ws-deleted`;
const WS_STOPPED = `${PREFIX}-ws-stopped`;
const WS_ON_STOPPED_NODE = `${PREFIX}-ws-stopped-node`;
const WS_OTHER_OWNER_NODE = `${PREFIX}-ws-other-owner-node`;
const WS_MISSING = `${PREFIX}-ws-missing`;
const WS_INSTANT = `${PREFIX}-ws-instant`;

let nodeToken: string;
let otherNodeToken: string;
let otherOwnerNodeToken: string;
let stoppedNodeToken: string;

/**
 * Same claims as production `signCallbackToken` / `signNodeCallbackToken`, with the issue
 * time moved `ageSeconds` into the past. A 24h token aged 13h is past the default 50%
 * refresh threshold; aged 25h it is expired.
 */
async function signAgedCallbackToken(
  subject: string,
  scope: 'workspace' | 'node',
  ageSeconds: number,
  options: { lifetimeSeconds?: number; generationIssuedAt?: number } = {}
): Promise<string> {
  const privateKey = await importPKCS8(testEnv.JWT_PRIVATE_KEY, 'RS256');
  const issuedAt = Math.floor(Date.now() / 1000) - ageSeconds;
  return new SignJWT({
    workspace: subject,
    type: 'callback',
    scope,
    ...(options.generationIssuedAt !== undefined
      ? { [CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM]: options.generationIssuedAt }
      : {}),
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://api.${testEnv.BASE_DOMAIN}`)
    .setSubject(subject)
    .setAudience('workspace-callback')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.lifetimeSeconds ?? DAY))
    .sign(privateKey);
}

function renew(
  workspaceId: string,
  workspaceToken: string | null,
  body: unknown
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (workspaceToken) headers.Authorization = `Bearer ${workspaceToken}`;
  return SELF.fetch(
    `https://api.test.example.com/api/workspaces/${workspaceId}/callback-token/renew`,
    {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }
  );
}

async function workspaceRow(
  workspaceId: string
): Promise<{ status: string; nodeId: string | null; updatedAt: string } | null> {
  return testEnv.DATABASE.prepare(
    'SELECT status, node_id AS nodeId, updated_at AS updatedAt FROM workspaces WHERE id = ?'
  )
    .bind(workspaceId)
    .first();
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: string };
  return body.error ?? '';
}

beforeAll(async () => {
  await seedUser(USER_ID);
  await seedUser(OTHER_USER_ID);
  await seedNode(NODE_ID, USER_ID);
  await seedNode(OTHER_NODE_ID, USER_ID);
  await seedNode(OTHER_OWNER_NODE_ID, OTHER_USER_ID);
  await seedNode(STOPPED_NODE_ID, USER_ID, { status: 'stopped', healthStatus: 'unhealthy' });
  await seedNode(INSTANT_NODE_ID, USER_ID);
  await testEnv.DATABASE.prepare("UPDATE nodes SET runtime = 'cf-container' WHERE id = ?")
    .bind(INSTANT_NODE_ID)
    .run();

  await seedWorkspace(WS_ACTIVE, NODE_ID, USER_ID, { status: 'running' });
  await seedWorkspace(WS_CREATING, NODE_ID, USER_ID, { status: 'creating' });
  await seedWorkspace(WS_ON_OTHER_NODE, OTHER_NODE_ID, USER_ID, { status: 'running' });
  await seedWorkspace(WS_DELETED, NODE_ID, USER_ID, { status: 'deleted' });
  await seedWorkspace(WS_STOPPED, NODE_ID, USER_ID, { status: 'stopped' });
  await seedWorkspace(WS_ON_STOPPED_NODE, STOPPED_NODE_ID, USER_ID, { status: 'running' });
  // Corrupt binding: placement never puts a workspace on another user's node.
  await seedWorkspace(WS_OTHER_OWNER_NODE, OTHER_OWNER_NODE_ID, USER_ID, { status: 'running' });
  await seedWorkspace(WS_INSTANT, INSTANT_NODE_ID, USER_ID, { status: 'running' });

  nodeToken = await signNodeCallbackToken(NODE_ID, testEnv);
  otherNodeToken = await signNodeCallbackToken(OTHER_NODE_ID, testEnv);
  otherOwnerNodeToken = await signNodeCallbackToken(OTHER_OWNER_NODE_ID, testEnv);
  stoppedNodeToken = await signNodeCallbackToken(STOPPED_NODE_ID, testEnv);
});

describe('POST /api/workspaces/:id/callback-token/renew', () => {
  it('renews an aged token for the hosting node and keeps the generation issue time', async () => {
    const aged = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 13 * HOUR);
    const agedClaims = decodeJwt(aged);

    const response = await renew(WS_ACTIVE, aged, { nodeId: NODE_ID, nodeToken });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as {
      renewed: boolean;
      token: string;
      expiresAt: string;
    };
    expect(body.renewed).toBe(true);
    const payload = await verifyCallbackToken(body.token, testEnv, {
      expectedScope: 'workspace',
    });
    expect(payload).toEqual({ workspace: WS_ACTIVE, type: 'callback', scope: 'workspace' });
    const renewedClaims = decodeJwt(body.token);
    expect(renewedClaims.sub).toBe(WS_ACTIVE);
    expect(renewedClaims.exp).toBeGreaterThan(agedClaims.exp as number);
    expect(new Date(body.expiresAt).getTime()).toBe((renewedClaims.exp as number) * 1000);
    expect(renewedClaims[CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM]).toBe(agedClaims.iat);
  });

  it('keeps the first generation across a chain of renewals', async () => {
    const originalIssuedAt = Math.floor(Date.now() / 1000) - 40 * HOUR;
    const agedRenewal = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 13 * HOUR, {
      generationIssuedAt: originalIssuedAt,
    });

    const response = await renew(WS_ACTIVE, agedRenewal, { nodeId: NODE_ID, nodeToken });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    expect(decodeJwt(body.token)[CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM]).toBe(originalIssuedAt);
  });

  it('does not mint while the token is younger than the refresh threshold', async () => {
    const fresh = await signCallbackToken(WS_ACTIVE, testEnv);

    const response = await renew(WS_ACTIVE, fresh, { nodeId: NODE_ID, nodeToken });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ renewed: false });
  });

  it('renews a workspace that is still creating', async () => {
    const aged = await signAgedCallbackToken(WS_CREATING, 'workspace', 20 * HOUR);
    const response = await renew(WS_CREATING, aged, { nodeId: NODE_ID, nodeToken });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { renewed: boolean }).renewed).toBe(true);
  });

  it('never renews a token that already expired (24h crossed)', async () => {
    const expired = await signAgedCallbackToken(WS_ACTIVE, 'workspace', DAY + HOUR);

    const response = await renew(WS_ACTIVE, expired, { nodeId: NODE_ID, nodeToken });

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('UNAUTHORIZED');
  });

  it('rejects a node token presented as the workspace credential', async () => {
    const response = await renew(WS_ACTIVE, nodeToken, { nodeId: NODE_ID, nodeToken });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('FORBIDDEN');
  });

  it('rejects a workspace token presented as the node credential', async () => {
    const aged = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 13 * HOUR);
    const otherWorkspaceToken = await signCallbackToken(WS_ON_OTHER_NODE, testEnv);

    const response = await renew(WS_ACTIVE, aged, {
      nodeId: WS_ON_OTHER_NODE,
      nodeToken: otherWorkspaceToken,
    });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('NODE_CALLBACK_FORBIDDEN');
  });

  it('requires the node credential: a workspace token alone cannot renew itself', async () => {
    const aged = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 13 * HOUR);

    const missingBody = await renew(WS_ACTIVE, aged, '');
    expect(missingBody.status).toBe(400);

    const emptyNodeToken = await renew(WS_ACTIVE, aged, { nodeId: NODE_ID, nodeToken: '' });
    expect(emptyNodeToken.status).toBe(400);
  });

  it('rejects an expired node token with the node-credential code', async () => {
    const aged = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 13 * HOUR);
    const expiredNodeToken = await signAgedCallbackToken(NODE_ID, 'node', DAY + HOUR);

    const response = await renew(WS_ACTIVE, aged, { nodeId: NODE_ID, nodeToken: expiredNodeToken });

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('NODE_CALLBACK_UNAUTHORIZED');
  });

  it('rejects a node token whose claim differs from the named node', async () => {
    const aged = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 13 * HOUR);

    const response = await renew(WS_ACTIVE, aged, { nodeId: NODE_ID, nodeToken: otherNodeToken });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('NODE_CALLBACK_FORBIDDEN');
  });

  it('refuses a node that does not host the workspace (moved/foreign node), owner control renews', async () => {
    const aged = await signAgedCallbackToken(WS_ON_OTHER_NODE, 'workspace', 13 * HOUR);
    const before = await workspaceRow(WS_ON_OTHER_NODE);

    const attack = await renew(WS_ON_OTHER_NODE, aged, { nodeId: NODE_ID, nodeToken });

    expect(attack.status).toBe(403);
    expect(await errorCode(attack)).toBe('FORBIDDEN');
    expect(await workspaceRow(WS_ON_OTHER_NODE)).toEqual(before);

    const owner = await renew(WS_ON_OTHER_NODE, aged, {
      nodeId: OTHER_NODE_ID,
      nodeToken: otherNodeToken,
    });
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { renewed: boolean }).renewed).toBe(true);
  });

  it("refuses a node owned by a different user than the workspace's", async () => {
    const aged = await signAgedCallbackToken(WS_OTHER_OWNER_NODE, 'workspace', 13 * HOUR);

    const response = await renew(WS_OTHER_OWNER_NODE, aged, {
      nodeId: OTHER_OWNER_NODE_ID,
      nodeToken: otherOwnerNodeToken,
    });

    expect(response.status).toBe(403);
  });

  it('refuses a token minted for another workspace', async () => {
    const tokenForActive = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 13 * HOUR);

    const response = await renew(WS_ON_OTHER_NODE, tokenForActive, {
      nodeId: OTHER_NODE_ID,
      nodeToken: otherNodeToken,
    });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('FORBIDDEN');
  });

  it.each([
    ['deleted workspace', WS_DELETED, NODE_ID, () => nodeToken],
    ['stopped workspace', WS_STOPPED, NODE_ID, () => nodeToken],
    ['workspace on a stopped node', WS_ON_STOPPED_NODE, STOPPED_NODE_ID, () => stoppedNodeToken],
  ])('ends renewal for a %s with 410', async (_label, workspaceId, nodeId, token) => {
    const aged = await signAgedCallbackToken(workspaceId, 'workspace', 13 * HOUR);
    const before = await workspaceRow(workspaceId);

    const response = await renew(workspaceId, aged, { nodeId, nodeToken: token() });

    expect(response.status).toBe(410);
    expect(await errorCode(response)).toBe('GONE');
    expect(await workspaceRow(workspaceId)).toEqual(before);
  });

  it('ends renewal for a workspace row that no longer exists', async () => {
    const aged = await signAgedCallbackToken(WS_MISSING, 'workspace', 13 * HOUR);
    const response = await renew(WS_MISSING, aged, { nodeId: NODE_ID, nodeToken });
    expect(response.status).toBe(410);
  });

  it('serves concurrent renewals of the same token independently', async () => {
    const aged = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 13 * HOUR);
    const agedIssuedAt = decodeJwt(aged).iat;

    const responses = await Promise.all(
      [0, 1, 2].map(() => renew(WS_ACTIVE, aged, { nodeId: NODE_ID, nodeToken }))
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      const body = (await response.json()) as { token: string };
      await expect(
        verifyCallbackToken(body.token, testEnv, { expectedScope: 'workspace' })
      ).resolves.toMatchObject({ workspace: WS_ACTIVE });
      expect(decodeJwt(body.token)[CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM]).toBe(agedIssuedAt);
    }
  });

  it('lets a workspace callback that failed after 24h succeed with the renewed token', async () => {
    const expired = await signAgedCallbackToken(WS_ACTIVE, 'workspace', DAY + HOUR);
    const rejected = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WS_ACTIVE}/runtime`,
      { headers: { Authorization: `Bearer ${expired}` } }
    );
    expect(rejected.status).toBe(401);

    const aged = await signAgedCallbackToken(WS_ACTIVE, 'workspace', 23 * HOUR);
    const renewal = await renew(WS_ACTIVE, aged, { nodeId: NODE_ID, nodeToken });
    const { token } = (await renewal.json()) as { token: string };

    const accepted = await SELF.fetch(
      `https://api.test.example.com/api/workspaces/${WS_ACTIVE}/runtime`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ workspaceId: WS_ACTIVE, nodeId: NODE_ID });
  });
});

describe('mintWorkspaceCallbackTokenForNodeDelivery', () => {
  it('mints a workspace token only for an active workspace bound to the target node', async () => {
    const token = await mintWorkspaceCallbackTokenForNodeDelivery(testEnv, {
      workspaceId: WS_ACTIVE,
      nodeId: NODE_ID,
    });
    expect(token).not.toBeNull();
    await expect(
      verifyCallbackToken(token as string, testEnv, { expectedScope: 'workspace' })
    ).resolves.toEqual({ workspace: WS_ACTIVE, type: 'callback', scope: 'workspace' });
  });

  it.each([
    ['workspace bound to another node', WS_ON_OTHER_NODE, NODE_ID],
    ['deleted workspace', WS_DELETED, NODE_ID],
    ['stopped workspace', WS_STOPPED, NODE_ID],
    ['workspace on a stopped node', WS_ON_STOPPED_NODE, STOPPED_NODE_ID],
    ['node owned by another user', WS_OTHER_OWNER_NODE, OTHER_OWNER_NODE_ID],
    ['missing workspace', WS_MISSING, NODE_ID],
    [
      'Instant (cf-container) runtime, which gets a fresh token per cold wake',
      WS_INSTANT,
      INSTANT_NODE_ID,
    ],
  ])('delivers nothing for a %s', async (_label, workspaceId, nodeId) => {
    await expect(
      mintWorkspaceCallbackTokenForNodeDelivery(testEnv, { workspaceId, nodeId })
    ).resolves.toBeNull();
  });
});

describe('hibernateAgentSessionOnNode workspace token delivery', () => {
  const fetchMock = vi.fn<typeof fetch>();

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  async function capturedHibernateBody(workspaceId: string, nodeId: string) {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending', accepted: true }), { status: 202 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await hibernateAgentSessionOnNode(nodeId, workspaceId, 'agent-session-1', testEnv, USER_ID, {
      chatSessionId: 'chat-1',
      runtime: 'vm',
      background: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain(
      `/workspaces/${workspaceId}/agent-sessions/agent-session-1/hibernate`
    );
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('carries a fresh workspace token to the node hosting an active workspace', async () => {
    const body = await capturedHibernateBody(WS_ACTIVE, NODE_ID);

    expect(body).toMatchObject({ chatSessionId: 'chat-1', runtime: 'vm', background: true });
    expect(typeof body.workspaceCallbackToken).toBe('string');
    await expect(
      verifyCallbackToken(body.workspaceCallbackToken as string, testEnv, {
        expectedScope: 'workspace',
      })
    ).resolves.toMatchObject({ workspace: WS_ACTIVE });
  });

  it('sends the request without a token when the workspace is not bound to that node', async () => {
    const body = await capturedHibernateBody(WS_ON_OTHER_NODE, NODE_ID);

    expect(body).toEqual({ chatSessionId: 'chat-1', runtime: 'vm', background: true });
  });
});
