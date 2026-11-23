/**
 * Project WebSockets end when the user's project access ends, through the real worker: sockets
 * are opened through `GET /api/projects/:projectId/sessions/ws` with real session cookies, and
 * access is revoked through the real offboarding and admin-suspension routes.
 *
 * The upgrade route checks membership only when a socket opens, so without the close a removed
 * or suspended user's open tab kept receiving project events (Codex Security finding
 * acf_064e2f55492d2ba99b2867ce3bcee6c9). Each case pairs the revoked user with a member who must
 * stay connected, proven by a ping answered after the revocation.
 */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const API = 'https://api.test.example.com';
/** `BROWSER_SOCKET_ACCESS_REVOKED_CLOSE_CODE` in `project-data/src/do/session-sockets.ts`. */
const ACCESS_REVOKED_CLOSE_CODE = 4403;
const testEnv = env as unknown as Env;

const suffix = crypto.randomUUID();
const OWNER = `sock-owner-${suffix}`;
const REMOVED = `sock-removed-${suffix}`;
const SUSPENDED = `sock-suspended-${suffix}`;
const STAYING = `sock-staying-${suffix}`;
const ADMIN = `sock-admin-${suffix}`;
const INSTALLATION = `sock-installation-${suffix}`;
const PROJECT_A = `sock-project-a-${suffix}`;
const PROJECT_B = `sock-project-b-${suffix}`;

const cookies: Record<string, string> = {};
let sessionId = '';

interface BrowserSocket {
  ws: WebSocket;
  frames: Array<{ type: string }>;
  closeCode: () => number | null;
}

function openSocket(projectId: string, userId: string, session?: string) {
  const query = session ? `?sessionId=${session}` : '';
  return SELF.fetch(`${API}/api/projects/${projectId}/sessions/ws${query}`, {
    headers: { Upgrade: 'websocket', Cookie: cookies[userId]! },
  });
}

async function connect(
  projectId: string,
  userId: string,
  session?: string
): Promise<BrowserSocket> {
  const response = await openSocket(projectId, userId, session);
  expect(response.status).toBe(101);
  return adopt(response.webSocket!);
}

function adopt(ws: WebSocket): BrowserSocket {
  ws.accept();
  const frames: Array<{ type: string }> = [];
  let code: number | null = null;
  ws.addEventListener('message', (event) => {
    frames.push(JSON.parse(event.data as string) as { type: string });
  });
  ws.addEventListener('close', (event) => {
    code = event.code;
  });
  return { ws, frames, closeCode: () => code };
}

async function settle(until: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!until()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The socket is still served after the revocation: a ping gets a pong. */
async function expectStillServed(socket: BrowserSocket, what: string): Promise<void> {
  const before = socket.frames.filter((frame) => frame.type === 'pong').length;
  socket.ws.send(JSON.stringify({ type: 'ping' }));
  await settle(
    () => socket.frames.filter((frame) => frame.type === 'pong').length > before,
    `${what} pong`
  );
  expect(socket.closeCode()).toBeNull();
}

function call(userId: string, method: string, path: string, body?: unknown) {
  return SELF.fetch(`${API}${path}`, {
    method,
    headers: {
      Cookie: cookies[userId]!,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function addMember(projectId: string, userId: string, role: string): Promise<void> {
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(projectId, userId, role, OWNER)
    .run();
}

beforeAll(async () => {
  for (const userId of [OWNER, REMOVED, SUSPENDED, STAYING, ADMIN]) {
    await seedUser(userId);
    cookies[userId] = await seedSignedInUser(userId);
  }
  await testEnv.DATABASE.prepare(`UPDATE users SET role = 'superadmin' WHERE id = ?`)
    .bind(ADMIN)
    .run();
  await seedInstallation(INSTALLATION, OWNER);
  for (const projectId of [PROJECT_A, PROJECT_B]) {
    await seedProject(projectId, OWNER, INSTALLATION);
    await addMember(projectId, SUSPENDED, 'maintainer');
    await addMember(projectId, STAYING, 'maintainer');
  }
  await addMember(PROJECT_A, REMOVED, 'maintainer');
  sessionId = await projectDataService.createSession(
    testEnv,
    PROJECT_A,
    null,
    'Socket revocation slice',
    null,
    OWNER
  );
});

describe('project sockets close when project access is revoked', () => {
  it('offboarding closes the removed member’s project and chat sockets, not a staying member’s', async () => {
    const removedProject = await connect(PROJECT_A, REMOVED);
    const removedChat = await connect(PROJECT_A, REMOVED, sessionId);
    const staying = await connect(PROJECT_A, STAYING, sessionId);
    await expectStillServed(removedChat, 'removed member before removal');

    const previewResponse = await call(
      OWNER,
      'POST',
      `/api/projects/${PROJECT_A}/members/${REMOVED}/offboarding-preview`
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as { offboardingPlanId: string };
    const applyResponse = await call(
      OWNER,
      'POST',
      `/api/projects/${PROJECT_A}/members/${REMOVED}/offboarding-apply`,
      { planId: preview.offboardingPlanId, actions: [], finalMemberStatus: 'removed' }
    );
    const applied = (await applyResponse.json()) as { status: string };
    expect(applyResponse.status, JSON.stringify(applied)).toBe(200);
    expect(applied.status).toBe('removed');

    await settle(() => removedProject.closeCode() !== null, 'removed project socket close');
    await settle(() => removedChat.closeCode() !== null, 'removed chat socket close');
    expect(removedProject.closeCode()).toBe(ACCESS_REVOKED_CLOSE_CODE);
    expect(removedChat.closeCode()).toBe(ACCESS_REVOKED_CLOSE_CODE);
    await expectStillServed(staying, 'staying member');

    // Reconnecting is refused at the upgrade, with the same answer a non-member gets.
    const reconnect = await openSocket(PROJECT_A, REMOVED);
    expect(reconnect.status).toBe(404);
  });

  it('suspension closes the user’s sockets on every project, not another member’s', async () => {
    const suspendedA = await connect(PROJECT_A, SUSPENDED);
    const suspendedB = await connect(PROJECT_B, SUSPENDED);
    const staying = await connect(PROJECT_B, STAYING);

    const response = await call(ADMIN, 'PATCH', `/api/admin/users/${SUSPENDED}`, {
      action: 'suspend',
    });
    expect(response.status).toBe(200);

    await settle(() => suspendedA.closeCode() !== null, 'suspended socket close on project A');
    await settle(() => suspendedB.closeCode() !== null, 'suspended socket close on project B');
    expect(suspendedA.closeCode()).toBe(ACCESS_REVOKED_CLOSE_CODE);
    expect(suspendedB.closeCode()).toBe(ACCESS_REVOKED_CLOSE_CODE);
    await expectStillServed(staying, 'other member on project B');

    // A suspended account cannot open a new socket.
    const reconnect = await openSocket(PROJECT_B, SUSPENDED);
    expect(reconnect.status).toBe(403);
    expect(await reconnect.json()).toMatchObject({ message: 'Your account has been suspended' });
    expect(reconnect.webSocket).toBeNull();
  });

  it('the object refuses a socket the API did not attribute to a user', async () => {
    const stub = testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(PROJECT_B));
    const response = await stub.fetch('https://project-data/ws', {
      headers: { Upgrade: 'websocket' },
    });

    expect(response.status).toBe(400);
    expect(response.webSocket).toBeNull();
  });

  it('a revocation also closes a socket admitted before sockets carried their user', async () => {
    const stub = testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(PROJECT_B));
    // Accepted with a session tag only, as the previous release admitted every socket.
    const legacyOpen = await runInDurableObject(stub, async (_instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[1], [`session:${crypto.randomUUID()}`]);
      return state
        .getWebSockets()
        .filter(
          (ws) =>
            ws.readyState === WebSocket.OPEN &&
            !state.getTags(ws).some((tag) => tag.startsWith('actor:'))
        ).length;
    });
    expect(legacyOpen).toBeGreaterThan(0);
    const staying = await connect(PROJECT_B, STAYING);

    const closed = await projectDataService.closeBrowserSocketsForActor(
      testEnv,
      PROJECT_B,
      `sock-nobody-${suffix}`
    );

    expect(closed).toBe(legacyOpen);
    const untaggedStillOpen = await runInDurableObject(
      stub,
      async (_instance, state) =>
        state
          .getWebSockets()
          .filter(
            (ws) =>
              ws.readyState === WebSocket.OPEN &&
              !state.getTags(ws).some((tag) => tag.startsWith('actor:'))
          ).length
    );
    expect(untaggedStillOpen).toBe(0);
    await expectStillServed(staying, 'tagged member of another user');
  });

  it('an upgrade that reaches the object after the revocation closed everything is closed too', async () => {
    // The upgrade route checked membership before the offboarding committed; the forwarded
    // upgrade arrives at the object after the close ran, so there was nothing to close yet.
    const lateMember = `sock-late-${crypto.randomUUID()}`;
    await seedUser(lateMember);
    await addMember(PROJECT_A, lateMember, 'maintainer');
    const preview = await call(
      OWNER,
      'POST',
      `/api/projects/${PROJECT_A}/members/${lateMember}/offboarding-preview`
    );
    const plan = (await preview.json()) as { offboardingPlanId: string };
    const removed = await call(
      OWNER,
      'POST',
      `/api/projects/${PROJECT_A}/members/${lateMember}/offboarding-apply`,
      {
        planId: plan.offboardingPlanId,
        actions: [],
        finalMemberStatus: 'removed',
      }
    );
    expect(removed.status).toBe(200);
    const stub = testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(PROJECT_A));
    const lateUpgrade = await stub.fetch('https://project-data/ws', {
      headers: { Upgrade: 'websocket', 'x-sam-browser-socket-actor': lateMember },
    });
    expect(lateUpgrade.status).toBe(101);
    const late = adopt(lateUpgrade.webSocket!);
    // Control: a current member admitted the same way stays connected.
    const memberUpgrade = await stub.fetch('https://project-data/ws', {
      headers: { Upgrade: 'websocket', 'x-sam-browser-socket-actor': STAYING },
    });
    const member = adopt(memberUpgrade.webSocket!);

    await settle(() => late.closeCode() !== null, 'late socket close');
    expect(late.closeCode()).toBe(ACCESS_REVOKED_CLOSE_CODE);
    await expectStillServed(member, 'member admitted directly');
  });
});
