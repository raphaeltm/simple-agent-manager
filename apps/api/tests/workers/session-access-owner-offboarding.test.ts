/**
 * Owner offboarding must revoke shared session access, end to end: real D1 membership, the
 * real member-offboarding routes (preview -> apply), the real ProjectData DO, and the real
 * chat-session-access and prompt routes (idea 01M59MYE4GY91BWTE8TZF1ZB5D).
 *
 * The project is Artifacts-backed so the grantee repository check has nothing external to
 * call (`verifyRepositoryUserAccess` returns early); workers tests cannot mock GitHub.
 *
 * The departing member holds the project's `owner` role, but a SECOND active owner (the
 * remover) is seeded so offboarding does not trip the "last owner requires transfer" guard
 * (`applyProjectMemberOffboarding`, `services/project-offboarding-apply.ts`).
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { chatRoutes } from '../../src/routes/chat';
import { projectMembersRoutes } from '../../src/routes/projects/members';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const suffix = crypto.randomUUID();
const OWNER = `offboard-owner-${suffix}`;
const GRANTEE = `offboard-grantee-${suffix}`;
const THIRD = `offboard-third-${suffix}`;
const INSTALLATION = `offboard-installation-${suffix}`;
const PROJECT = `offboard-project-${suffix}`;

const cookies: Record<string, string> = {};
let sessionId = '';

function app() {
  const root = new Hono<{ Bindings: Env }>();
  root.onError(handleAppError);
  root.use('/api/projects/*', requireAuth(), requireApproved());
  root.route('/api/projects/:projectId/sessions', chatRoutes);
  root.route('/api/projects', projectMembersRoutes);
  return root;
}

function request(userId: string, method: string, path: string, body?: unknown) {
  return app().request(
    path,
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

function sessionPath(suffixPath: string): string {
  return `/api/projects/${PROJECT}/sessions/${sessionId}${suffixPath}`;
}

function share(actor: string, granteeUserId: string) {
  return request(actor, 'POST', sessionPath('/access/grants'), {
    userId: granteeUserId,
    acknowledgeSharedCredentials: true,
  });
}

function prompt(actor: string, content: string) {
  return request(actor, 'POST', sessionPath('/prompt'), { content });
}

function access(actor: string) {
  return request(actor, 'GET', sessionPath('/access'));
}

function memberPath(memberUserId: string, action: 'offboarding-preview' | 'offboarding-apply') {
  return `/api/projects/${PROJECT}/members/${memberUserId}/${action}`;
}

async function addMember(userId: string, role: string): Promise<void> {
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(PROJECT, userId, role, OWNER)
    .run();
}

function projectDataStub() {
  return testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(PROJECT));
}

async function grantRow(granteeUserId: string) {
  return runInDurableObject(projectDataStub(), async (_instance, state) => {
    const row = state.storage.sql
      .exec(
        `SELECT grantee_user_id, parent_grant_id, revoke_reason, revoked_by_user_id
           FROM chat_session_access_grants
          WHERE session_id = ? AND grantee_user_id = ?
          ORDER BY created_at DESC LIMIT 1`,
        sessionId,
        granteeUserId
      )
      .toArray()[0];
    return row as
      | {
          grantee_user_id: string;
          parent_grant_id: string | null;
          revoke_reason: string | null;
          revoked_by_user_id: string | null;
        }
      | undefined;
  });
}

async function inboxRow(deliveryId: string) {
  return runInDurableObject(projectDataStub(), async (_instance, state) => {
    const row = state.storage.sql
      .exec(`SELECT delivery_state, terminal_reason FROM session_inbox WHERE id = ?`, deliveryId)
      .toArray()[0];
    return row as { delivery_state: string; terminal_reason: string | null } | undefined;
  });
}

describe('session access owner offboarding', () => {
  beforeAll(async () => {
    for (const userId of [OWNER, GRANTEE, THIRD]) {
      await seedUser(userId, { name: `Name ${userId.split('-')[1]}` });
      cookies[userId] = await seedSignedInUser(userId);
    }
    await seedInstallation(INSTALLATION, OWNER);
    // Creator becomes the project's sole `owner` member.
    await seedProject(PROJECT, OWNER, INSTALLATION);
    await testEnv.DATABASE.prepare(`UPDATE projects SET repo_provider = 'artifacts' WHERE id = ?`)
      .bind(PROJECT)
      .run();
    await addMember(GRANTEE, 'maintainer');
    // A second active owner so removing OWNER does not trip "last owner requires transfer".
    await addMember(THIRD, 'owner');

    sessionId = await projectDataService.createSession(
      testEnv,
      PROJECT,
      null,
      'Owner offboarding slice',
      null,
      OWNER
    );
  });

  it('lets the owner share the session with the grantee', async () => {
    const response = await share(OWNER, GRANTEE);

    expect(response.status).toBe(201);
    const grant = await grantRow(GRANTEE);
    expect(grant).toMatchObject({
      grantee_user_id: GRANTEE,
      parent_grant_id: null,
      revoke_reason: null,
    });
  });

  it('control: the grantee can prompt on the owner’s session while the owner is still active', async () => {
    const response = await prompt(GRANTEE, 'Before the owner leaves');

    expect(response.status).toBe(202);
    const { deliveryId } = (await response.json()) as { deliveryId: string };
    const row = await inboxRow(deliveryId);
    expect(row?.delivery_state).not.toBe('failed');
  });

  it('removing the owner revokes the grant, fails the queued prompt, and refuses a fresh one', async () => {
    const queued = await prompt(GRANTEE, 'Queued right before the owner leaves');
    expect(queued.status).toBe(202);
    const { deliveryId } = (await queued.json()) as { deliveryId: string };

    // Preview first: a plain owner member attributes no personal resources here, so the plan
    // is immediately applyable with nothing for the remover to decide.
    const previewResponse = await request(THIRD, 'POST', memberPath(OWNER, 'offboarding-preview'));
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      offboardingPlanId: string;
      canApply: boolean;
      resources: unknown[];
    };
    expect(preview.canApply).toBe(true);
    expect(preview.resources).toEqual([]);

    const applyResponse = await request(THIRD, 'POST', memberPath(OWNER, 'offboarding-apply'), {
      planId: preview.offboardingPlanId,
      actions: [],
      finalMemberStatus: 'removed',
    });
    const applyBody = (await applyResponse.json()) as { status: string };
    expect(applyResponse.status, JSON.stringify(applyBody)).toBe(200);
    expect(applyBody.status).toBe('removed');

    // The grant the grantee held is revoked specifically because the owner left the project —
    // not a generic revoke and not left dangling.
    const grant = await grantRow(GRANTEE);
    expect(grant).toMatchObject({
      grantee_user_id: GRANTEE,
      revoke_reason: 'owner_removed',
    });
    expect(grant?.revoked_by_user_id).toBeNull();

    // GET /access only requires task:read (still held — the grantee remains an active
    // maintainer), so it succeeds and now reports the grantee back to plain reader access.
    const accessResponse = await access(GRANTEE);
    const accessBody = (await accessResponse.json()) as { viewerAccess: string };
    expect(accessResponse.status, JSON.stringify(accessBody)).toBe(200);
    expect(accessBody.viewerAccess).toBe('reader');

    // The prompt queued just before removal is cancelled with the access-revoked reason.
    expect(await inboxRow(deliveryId)).toMatchObject({
      delivery_state: 'failed',
      terminal_reason: 'sender_access_revoked',
    });

    // A fresh prompt attempt after removal is refused outright.
    const freshResponse = await prompt(GRANTEE, 'After the owner left');
    expect(freshResponse.status).toBe(403);
  });
});
