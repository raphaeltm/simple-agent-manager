/**
 * Shared session access, end to end through the real routes, real D1 membership, real auth
 * cookies and the real ProjectData Durable Object (idea 01M59MYE4GY91BWTE8TZF1ZB5D).
 *
 * The project is Artifacts-backed so nothing in the slice reaches GitHub, which workers tests
 * cannot mock. Grant expiry has its own slice: session-access-expiry.test.ts.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { chatRoutes } from '../../src/routes/chat';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const suffix = crypto.randomUUID();
const OWNER = `share-owner-${suffix}`;
const GRANTEE = `share-grantee-${suffix}`;
const GRANTEE_2 = `share-grantee2-${suffix}`;
const READER = `share-reader-${suffix}`;
const OUTSIDER = `share-outsider-${suffix}`;
const INSTALLATION = `share-installation-${suffix}`;
const PROJECT = `share-project-${suffix}`;

const cookies: Record<string, string> = {};
let sessionId = '';
let messageId = '';

function app() {
  const root = new Hono<{ Bindings: Env }>();
  root.onError(handleAppError);
  root.use('/api/projects/*', requireAuth(), requireApproved());
  root.route('/api/projects/:projectId/sessions', chatRoutes);
  return root;
}

function call(userId: string, method: string, path: string, body?: unknown) {
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

function share(actor: string, granteeUserId: string) {
  return call(actor, 'POST', '/access/grants', {
    userId: granteeUserId,
    durationMinutes: 30,
    acknowledgeSharedCredentials: true,
  });
}

function projectDataStub() {
  return testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(PROJECT));
}

async function inboxRow(deliveryId: string) {
  return runInDurableObject(projectDataStub(), async (_instance, state) => {
    const row = state.storage.sql
      .exec(
        `SELECT sender_id, delivery_state, terminal_reason, metadata, content, prompt_message_id
           FROM session_inbox WHERE id = ?`,
        deliveryId
      )
      .toArray()[0];
    return row as
      | {
          sender_id: string;
          delivery_state: string;
          terminal_reason: string | null;
          metadata: string | null;
          content: string;
          prompt_message_id: string | null;
        }
      | undefined;
  });
}

/**
 * Hold deliveries to the session the way a mid-turn agent does (a busy backoff), so a queued
 * prompt stays queued. Without it the prompt is attempted at once and, with no runtime in this
 * harness, can fail on its own before the revoke the test is about.
 */
async function holdDeliveries() {
  await runInDurableObject(projectDataStub(), async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO prompt_delivery_target_backoff
         (target_session_id, busy_attempts, next_attempt_at, message_priority)
       VALUES (?, 1, ?, 2)
       ON CONFLICT(target_session_id) DO UPDATE SET next_attempt_at = excluded.next_attempt_at`,
      sessionId,
      Date.now() + 10 * 60_000
    );
  });
}

async function inboxCount() {
  return runInDurableObject(projectDataStub(), async (_instance, state) => {
    const row = state.storage.sql
      .exec('SELECT COUNT(*) AS count FROM session_inbox WHERE target_session_id = ?', sessionId)
      .toArray()[0];
    return Number(row?.count ?? 0);
  });
}

async function grantRows() {
  return runInDurableObject(projectDataStub(), async (_instance, state) =>
    state.storage.sql
      .exec(
        `SELECT grantee_user_id, parent_grant_id, revoke_reason, revoked_by_user_id
           FROM chat_session_access_grants WHERE session_id = ? ORDER BY created_at, id`,
        sessionId
      )
      .toArray()
  );
}

async function viewerAccess(userId: string): Promise<string> {
  const response = await call(userId, 'GET', '/access');
  expect(response.status).toBe(200);
  return ((await response.json()) as { viewerAccess: string }).viewerAccess;
}

async function addMember(userId: string, role: string) {
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(PROJECT, userId, role, OWNER)
    .run();
}

describe('shared session access vertical slice', () => {
  beforeAll(async () => {
    for (const userId of [OWNER, GRANTEE, GRANTEE_2, READER, OUTSIDER]) {
      await seedUser(userId, { name: `Name ${userId.split('-')[1]}` });
      cookies[userId] = await seedSignedInUser(userId);
    }
    await seedInstallation(INSTALLATION, OWNER);
    await seedProject(PROJECT, OWNER, INSTALLATION);
    await testEnv.DATABASE.prepare(`UPDATE projects SET repo_provider = 'artifacts' WHERE id = ?`)
      .bind(PROJECT)
      .run();
    await addMember(GRANTEE, 'maintainer');
    await addMember(GRANTEE_2, 'maintainer');
    await addMember(READER, 'maintainer');

    sessionId = await projectDataService.createSession(
      testEnv,
      PROJECT,
      null,
      'Shared session vertical slice',
      null,
      OWNER
    );
    messageId = await projectDataService.persistMessage(
      testEnv,
      PROJECT,
      sessionId,
      'assistant',
      'Here is my plan for the migration.',
      null
    );
  });

  it('refuses to let a teammate without control share the session', async () => {
    const response = await share(READER, GRANTEE);

    expect(response.status).toBe(403);
    expect(await grantRows()).toEqual([]);
  });

  it('only shares with active members, and requires the shared-accounts acknowledgment', async () => {
    expect((await share(OWNER, OUTSIDER)).status).toBe(400);
    const unacknowledged = await call(OWNER, 'POST', '/access/grants', {
      userId: GRANTEE,
      durationMinutes: 30,
    });
    expect(unacknowledged.status).toBe(400);
    expect(await grantRows()).toEqual([]);
  });

  it('lets the owner share, and every member sees who has access', async () => {
    const response = await share(OWNER, GRANTEE);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      created: boolean;
      grant: { grantee: { id: string }; grantedBy: { id: string } };
      access: { viewerAccess: string; owner: { id: string }; grants: unknown[] };
    };
    expect(body.created).toBe(true);
    expect(body.grant.grantee.id).toBe(GRANTEE);
    expect(body.grant.grantedBy.id).toBe(OWNER);
    expect(body.access).toMatchObject({ viewerAccess: 'owner', owner: { id: OWNER } });
    expect(body.access.grants).toHaveLength(1);

    expect(await viewerAccess(GRANTEE)).toBe('grantee');
    expect(await viewerAccess(READER)).toBe('reader');
    // Sharing again is idempotent.
    expect((await share(OWNER, GRANTEE)).status).toBe(200);

    const detail = await call(GRANTEE, 'GET', '');
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      session: { id: sessionId, viewerAccess: 'grantee' },
    });
  });

  it('queues a grantee prompt as the grantee, on the owner’s session, with a speaker line', async () => {
    const response = await call(GRANTEE, 'POST', '/prompt', { content: 'Please add a test' });

    expect(response.status).toBe(202);
    const { deliveryId } = (await response.json()) as { deliveryId: string };
    const row = await inboxRow(deliveryId);
    expect(row?.sender_id).toBe(GRANTEE);
    expect(JSON.parse(row?.metadata ?? '{}')).toMatchObject({
      userId: GRANTEE,
      onBehalfOfUserId: OWNER,
    });
    expect(row?.content).toContain('a project member with shared access to this session');
    expect(row?.content).toMatch(
      /Everything after this line is their message as typed\.\]\n\nPlease add a test/
    );
    expect(row?.content).toContain('Please add a test');
  });

  it('refuses a prompt from a teammate the session was not shared with', async () => {
    const before = await inboxCount();

    const response = await call(READER, 'POST', '/prompt', { content: 'Delete everything' });

    expect(response.status).toBe(403);
    expect(await inboxCount()).toBe(before);
  });

  it('lets any teammate comment, but only a session writer send it to the agent (gap G2)', async () => {
    const created = await call(READER, 'POST', '/comments', {
      messageId,
      body: 'This misses the rollback step.',
    });
    expect(created.status).toBe(201);
    const { thread } = (await created.json()) as { thread: { id: string } };
    const before = await inboxCount();

    const readerSend = await call(READER, 'POST', `/comments/${thread.id}/send`, {});
    expect(readerSend.status).toBe(403);
    expect(await inboxCount()).toBe(before);

    const granteeSend = await call(GRANTEE, 'POST', `/comments/${thread.id}/send`, {});
    expect(granteeSend.status).toBe(202);
    const row = await inboxRow(`comment-directive-${thread.id}`);
    expect(row?.sender_id).toBe(GRANTEE);
    expect(JSON.parse(row?.metadata ?? '{}')).toMatchObject({
      commentThreadId: thread.id,
      onBehalfOfUserId: OWNER,
    });
    expect(row?.content).toContain('(shared access to this session)');
  });

  it('cascades a revoke and cancels the revoked people’s undelivered prompts', async () => {
    // The grantee shares onward; that grant hangs off theirs.
    expect((await share(GRANTEE, GRANTEE_2)).status).toBe(201);
    await holdDeliveries();
    const queued = await call(GRANTEE_2, 'POST', '/prompt', { content: 'Second-hand prompt' });
    expect(queued.status).toBe(202);
    const { deliveryId } = (await queued.json()) as { deliveryId: string };
    expect(await inboxRow(deliveryId)).toMatchObject({ delivery_state: 'queued' });

    const response = await call(OWNER, 'DELETE', `/access/grants/${GRANTEE}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      revokedGrantIds: string[];
      cancelledDeliveryIds: string[];
      access: { grants: unknown[] };
    };
    expect(body.revokedGrantIds).toHaveLength(2);
    expect(body.cancelledDeliveryIds).toContain(deliveryId);
    expect(body.access.grants).toEqual([]);
    expect(await inboxRow(deliveryId)).toMatchObject({
      delivery_state: 'failed',
      terminal_reason: 'sender_access_revoked',
    });
    expect(await grantRows()).toEqual([
      expect.objectContaining({
        grantee_user_id: GRANTEE,
        revoke_reason: 'revoked',
        revoked_by_user_id: OWNER,
      }),
      expect.objectContaining({ grantee_user_id: GRANTEE_2, revoke_reason: 'cascade' }),
    ]);

    // Both are readers again, and the server refuses their prompts.
    expect(await viewerAccess(GRANTEE)).toBe('reader');
    expect(await viewerAccess(GRANTEE_2)).toBe('reader');
    expect((await call(GRANTEE, 'POST', '/prompt', { content: 'Still here?' })).status).toBe(403);

    // Every access read says that message was never delivered, so a page that cached the row
    // before it was labelled still shows the label: the revoke response, a later access read,
    // and the session detail a reload reads.
    const cancelled = [
      {
        messageId: (await inboxRow(deliveryId))?.prompt_message_id,
        reason: 'sender_access_revoked',
      },
    ];
    expect(cancelled[0]?.messageId).toEqual(expect.any(String));
    // Earlier tests in this file share the session, so other cancelled messages may be listed.
    expect((body.access as { undelivered?: unknown[] }).undelivered).toContainEqual(cancelled[0]);
    const accessRead = (await (await call(GRANTEE_2, 'GET', '/access')).json()) as {
      undelivered?: unknown[];
    };
    expect(accessRead.undelivered).toContainEqual(cancelled[0]);
    const detail = (await (await call(OWNER, 'GET', '')).json()) as {
      session: { access?: { undelivered?: unknown[] } };
    };
    expect(detail.session.access?.undelivered).toContainEqual(cancelled[0]);
  });

  it('lets a grantee leave on their own', async () => {
    expect((await share(OWNER, GRANTEE)).status).toBe(201);

    const response = await call(GRANTEE, 'DELETE', `/access/grants/${GRANTEE}`);

    expect(response.status).toBe(200);
    expect(await viewerAccess(GRANTEE)).toBe('reader');
    const rows = await grantRows();
    expect(rows.at(-1)).toMatchObject({ grantee_user_id: GRANTEE, revoke_reason: 'left' });
  });
});
