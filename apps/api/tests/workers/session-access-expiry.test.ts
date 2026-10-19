/**
 * Shared session access expiry, end to end: the real routes, real D1 membership, real auth
 * cookies and the real ProjectData Durable Object, alarm included (idea
 * 01M59MYE4GY91BWTE8TZF1ZB5D, required refinement of 2026-10-19).
 *
 * Time passing is the trigger and a test cannot wait five minutes, so expiry is reached by
 * moving a grant's `expires_at` into the past in the object's own storage. Everything after that
 * is production code: the routes read server time, and `alarm()` runs the expiry section.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { chatRoutes } from '../../src/routes/chat';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const suffix = crypto.randomUUID();
const OWNER = `expiry-owner-${suffix}`;
const GRANTEE = `expiry-grantee-${suffix}`;
const GRANTEE_2 = `expiry-grantee2-${suffix}`;
const INSTALLATION = `expiry-installation-${suffix}`;
const PROJECT = `expiry-project-${suffix}`;
const MINUTE = 60_000;

const cookies: Record<string, string> = {};

function app() {
  const root = new Hono<{ Bindings: Env }>();
  root.onError(handleAppError);
  root.use('/api/projects/*', requireAuth(), requireApproved());
  root.route('/api/projects/:projectId/sessions', chatRoutes);
  return root;
}

function call(userId: string, method: string, sessionId: string, path: string, body?: unknown) {
  return app().request(
    `/api/projects/${PROJECT}/sessions/${sessionId}${path}`,
    {
      method,
      headers: {
        Cookie: cookies[userId]!,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    testEnv
  );
}

function share(actor: string, sessionId: string, granteeUserId: string, durationMinutes?: number) {
  return call(actor, 'POST', sessionId, '/access/grants', {
    userId: granteeUserId,
    acknowledgeSharedCredentials: true,
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
  });
}

function stub(): DurableObjectStub<ProjectData> {
  return testEnv.PROJECT_DATA.get(
    testEnv.PROJECT_DATA.idFromName(PROJECT)
  ) as DurableObjectStub<ProjectData>;
}

/** Move a grant's end time, standing in for the clock passing it. */
async function setExpiresAt(sessionId: string, granteeUserId: string, expiresAt: number) {
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE chat_session_access_grants SET expires_at = ?
        WHERE session_id = ? AND grantee_user_id = ? AND revoked_at IS NULL`,
      expiresAt,
      sessionId,
      granteeUserId
    );
  });
}

/**
 * Hold deliveries to this chat the way a mid-turn agent does (a busy backoff), so a queued prompt
 * stays queued. Without it the prompt is attempted at once and, with no runtime in this harness,
 * fails on its own before the expiry the test is about.
 */
async function holdDeliveries(sessionId: string) {
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO prompt_delivery_target_backoff
         (target_session_id, busy_attempts, next_attempt_at, message_priority)
       VALUES (?, 1, ?, 2)`,
      sessionId,
      Date.now() + 10 * MINUTE
    );
  });
}

async function grantRow(sessionId: string, granteeUserId: string) {
  return runInDurableObject(stub(), async (_instance, state) => {
    return state.storage.sql
      .exec(
        `SELECT id, expires_at, duration_minutes, expiry_handled_at, revoked_at
           FROM chat_session_access_grants WHERE session_id = ? AND grantee_user_id = ?`,
        sessionId,
        granteeUserId
      )
      .toArray()[0] as
      | {
          id: string;
          expires_at: number | null;
          duration_minutes: number | null;
          expiry_handled_at: number | null;
          revoked_at: number | null;
        }
      | undefined;
  });
}

async function inboxRow(deliveryId: string) {
  return runInDurableObject(stub(), async (_instance, state) => {
    return state.storage.sql
      .exec(
        `SELECT i.delivery_state, i.terminal_reason, i.last_error, m.tool_metadata
           FROM session_inbox i LEFT JOIN chat_messages m ON m.id = i.prompt_message_id
          WHERE i.id = ?`,
        deliveryId
      )
      .toArray()[0] as
      | {
          delivery_state: string;
          terminal_reason: string | null;
          last_error: string | null;
          tool_metadata: string | null;
        }
      | undefined;
  });
}

async function runAlarm() {
  await runInDurableObject(stub(), async (instance) => {
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
}

async function subscribe(sessionId: string) {
  const response = await stub().fetch(`https://do/ws?sessionId=${sessionId}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const events: Array<Record<string, unknown>> = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data as string) as {
      type?: string;
      payload?: Record<string, unknown>;
    };
    if (message.type === 'session.access.changed') events.push(message.payload ?? {});
  });
  return { ws, events };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function viewerAccess(userId: string, sessionId: string) {
  const response = await call(userId, 'GET', sessionId, '/access');
  expect(response.status).toBe(200);
  return ((await response.json()) as { viewerAccess: string }).viewerAccess;
}

async function newSession(topic: string) {
  return projectDataService.createSession(testEnv, PROJECT, null, topic, null, OWNER);
}

async function addMember(userId: string) {
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, 'maintainer', 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(PROJECT, userId, OWNER)
    .run();
}

describe('shared session access expiry', () => {
  beforeAll(async () => {
    for (const userId of [OWNER, GRANTEE, GRANTEE_2]) {
      await seedUser(userId, { name: `Name ${userId.split('-')[1]}` });
      cookies[userId] = await seedSignedInUser(userId);
    }
    await seedInstallation(INSTALLATION, OWNER);
    await seedProject(PROJECT, OWNER, INSTALLATION);
    await testEnv.DATABASE.prepare(`UPDATE projects SET repo_provider = 'artifacts' WHERE id = ?`)
      .bind(PROJECT)
      .run();
    await addMember(GRANTEE);
    await addMember(GRANTEE_2);
  });

  it('refuses a share without a duration, and writes nothing', async () => {
    const sessionId = await newSession('No duration');

    const response = await share(OWNER, sessionId, GRANTEE);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Choose how long access lasts: 5, 10, 30 or 60 minutes',
    });
    expect(await grantRow(sessionId, GRANTEE)).toBeUndefined();
  });

  it('records the chosen duration and end time, and tells clients the server time', async () => {
    const sessionId = await newSession('Five minutes');
    const before = Date.now();

    const response = await share(OWNER, sessionId, GRANTEE, 5);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      grant: { expiresAt: number; durationMinutes: number };
      access: { serverTime: number };
    };
    expect(body.grant.durationMinutes).toBe(5);
    expect(body.grant.expiresAt).toBeGreaterThanOrEqual(before + 5 * MINUTE);
    expect(body.grant.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * MINUTE);
    expect(body.access.serverTime).toBeGreaterThanOrEqual(before);
  });

  it('lets the owner renew from now, while a grantee re-sharing changes nothing', async () => {
    const sessionId = await newSession('Renewal');
    expect((await share(OWNER, sessionId, GRANTEE, 5)).status).toBe(201);
    expect((await share(GRANTEE, sessionId, GRANTEE_2, 5)).status).toBe(201);
    const childExpiry = (await grantRow(sessionId, GRANTEE_2))?.expires_at;

    const renewed = await share(OWNER, sessionId, GRANTEE, 60);
    expect(renewed.status).toBe(200);
    const renewedBody = (await renewed.json()) as {
      created: boolean;
      renewed: boolean;
      grant: { durationMinutes: number; expiresAt: number };
    };
    expect(renewedBody).toMatchObject({ created: false, renewed: true });
    expect(renewedBody.grant.durationMinutes).toBe(60);
    expect(renewedBody.grant.expiresAt).toBeGreaterThan(Date.now() + 59 * MINUTE);

    const reshare = await share(GRANTEE, sessionId, GRANTEE_2, 60);
    expect(reshare.status).toBe(200);
    await expect(reshare.json()).resolves.toMatchObject({ created: false, renewed: false });
    expect((await grantRow(sessionId, GRANTEE_2))?.expires_at).toBe(childExpiry);
  });

  it('ends access at expires_at on every path, before any sweep has run', async () => {
    const sessionId = await newSession('Ends on time');
    expect((await share(OWNER, sessionId, GRANTEE, 5)).status).toBe(201);
    expect(await viewerAccess(GRANTEE, sessionId)).toBe('grantee');

    await setExpiresAt(sessionId, GRANTEE, Date.now() - 1);

    expect(await viewerAccess(GRANTEE, sessionId)).toBe('reader');
    expect((await call(GRANTEE, 'POST', sessionId, '/prompt', { content: 'Late' })).status).toBe(
      403
    );
    expect((await share(GRANTEE, sessionId, GRANTEE_2, 5)).status).toBe(403);
    const detail = await call(GRANTEE, 'GET', sessionId, '');
    await expect(detail.json()).resolves.toMatchObject({ session: { viewerAccess: 'reader' } });
    // Nothing was written: the check alone ended access.
    expect(await grantRow(sessionId, GRANTEE)).toMatchObject({
      revoked_at: null,
      expiry_handled_at: null,
    });
  });

  it('the alarm cancels queued prompts and tells open clients, once', async () => {
    const sessionId = await newSession('Swept');
    expect((await share(OWNER, sessionId, GRANTEE, 5)).status).toBe(201);
    await holdDeliveries(sessionId);
    const queued = await call(GRANTEE, 'POST', sessionId, '/prompt', { content: 'Queued' });
    expect(queued.status).toBe(202);
    const { deliveryId } = (await queued.json()) as { deliveryId: string };
    const { ws, events } = await subscribe(sessionId);
    expect(await inboxRow(deliveryId)).toMatchObject({ delivery_state: 'queued' });

    await setExpiresAt(sessionId, GRANTEE, Date.now() - 1);
    await runAlarm();
    await settle();

    expect(await inboxRow(deliveryId)).toMatchObject({
      delivery_state: 'failed',
      terminal_reason: 'sender_access_expired',
      last_error: "The sender's access to this session expired",
    });
    const metadata = JSON.parse((await inboxRow(deliveryId))?.tool_metadata ?? '{}') as {
      deliveryCancelled?: string;
    };
    expect(metadata.deliveryCancelled).toBe('sender_access_expired');
    expect(events).toEqual([{ sessionId, reason: 'expired' }]);
    expect((await grantRow(sessionId, GRANTEE))?.expiry_handled_at).not.toBeNull();

    // A second tick finds nothing left to do and says nothing.
    await runAlarm();
    await settle();
    expect(events).toHaveLength(1);
    ws.close();
  });

  it('a regrant after expiry gives access again without reviving the old queued prompt', async () => {
    const sessionId = await newSession('Regrant');
    expect((await share(OWNER, sessionId, GRANTEE, 5)).status).toBe(201);
    await holdDeliveries(sessionId);
    const queued = await call(GRANTEE, 'POST', sessionId, '/prompt', { content: 'Old' });
    const { deliveryId } = (await queued.json()) as { deliveryId: string };
    expect(await inboxRow(deliveryId)).toMatchObject({ delivery_state: 'queued' });
    await setExpiresAt(sessionId, GRANTEE, Date.now() - 1);

    const regrant = await share(OWNER, sessionId, GRANTEE, 10);

    expect(regrant.status).toBe(201);
    expect(await viewerAccess(GRANTEE, sessionId)).toBe('grantee');
    expect(await inboxRow(deliveryId)).toMatchObject({
      delivery_state: 'failed',
      terminal_reason: 'sender_access_expired',
    });
  });
});
