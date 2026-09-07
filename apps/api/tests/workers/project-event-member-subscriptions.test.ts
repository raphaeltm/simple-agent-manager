import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { projectEventSubscriptionRoutes } from '../../src/routes/project-event-subscriptions';
import * as projectData from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;

/** Only browser authentication is substituted; membership, routes, D1 and DO RPCs are real. */
function request(projectId: string, userId: string | null, suffix = '', body?: unknown) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (userId)
      c.set('auth', {
        user: {
          id: userId,
          email: `${userId}@test.com`,
          name: null,
          avatarUrl: null,
          role: 'user',
          status: 'active',
        },
        session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
      });
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toJSON(), error.statusCode as 400);
    throw error;
  });
  app.route('/api/projects/:projectId/event-subscriptions', projectEventSubscriptionRoutes);
  return app.request(
    `https://api.test/api/projects/${projectId}/event-subscriptions${suffix}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    },
    testEnv
  );
}

async function fixture() {
  const id = crypto.randomUUID();
  const owner = `owner-${id}`;
  const project = `project-${id}`;
  await seedUser(owner);
  await seedInstallation(id, owner, { installationIdValue: id, accountName: owner });
  await seedProject(project, owner, id);
  const member = async (role: 'viewer' | 'maintainer', status = 'active') => {
    const user = `${role}-${crypto.randomUUID()}`;
    await seedUser(user);
    await env.DATABASE.prepare(
      `INSERT INTO project_members
      (project_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(project, user, role, status)
      .run();
    return user;
  };
  const subscribe = async (
    sessionId: string,
    type: 'agent' | 'human' | 'policy' | 'system' | 'standing_watch' = 'agent'
  ) => {
    const result = await projectData.createProjectEventSubscription(testEnv, project, {
      owner: { type, id: owner },
      idempotencyKey: crypto.randomUUID(),
      filter: { version: 1, source: 'github' },
      deliveryPreference: {
        requested: 'record_only',
        resolved: 'record_only',
        target: { sessionId },
      },
      reason: 'Await the current commit',
    });
    return result.subscription;
  };
  return { project, owner, member, subscribe };
}

describe('member event subscription controls with real storage', () => {
  it('requires browser authentication through the combined production route tree', async () => {
    for (const suffix of ['', '/subscription', '/subscription/cancel']) {
      const response = await SELF.fetch(
        `https://api.test.example.com/api/projects/project/event-subscriptions${suffix}`,
        {
          method: suffix.endsWith('/cancel') ? 'POST' : 'GET',
        }
      );
      expect(response.status).toBe(401);
    }
  });
  it('filters by session before limiting, and keeps project reads isolated', async () => {
    const a = await fixture();
    const b = await fixture();
    const wanted = await a.subscribe('target');
    await a.subscribe('other');
    await a.subscribe('other');
    const viewer = await a.member('viewer');
    const response = await request(a.project, viewer, '?sessionId=target&limit=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subscriptions: [{ id: wanted.id }],
      hasMore: false,
    });
    expect((await request(b.project, viewer)).status).toBe(404);
    expect((await request(b.project, b.owner, `/${wanted.id}`)).status).toBe(404);
  });

  it('enforces real read/write membership and attributes cancellation to the verified human', async () => {
    const f = await fixture();
    const subscription = await f.subscribe('session');
    const viewer = await f.member('viewer');
    const maintainer = await f.member('maintainer');
    const suspended = await f.member('maintainer', 'suspended');
    expect((await request(f.project, null)).status).toBe(401);
    expect((await request(f.project, suspended)).status).toBe(404);
    expect((await request(f.project, viewer, `/${subscription.id}`)).status).toBe(200);
    expect((await request(f.project, viewer, `/${subscription.id}/cancel`, {})).status).toBe(403);
    await projectData.admitProjectEvent(testEnv, f.project, {
      source: 'github',
      eventType: 'check_run.completed',
      subject: { type: 'commit', id: 'sha' },
      deliveryKey: 'key',
      payloadFingerprint: 'payload',
    });
    const cancelled = await request(f.project, maintainer, `/${subscription.id}/cancel`, {
      reason: 'No longer needed',
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      subscription: {
        state: 'cancelled',
        cancelledBy: { type: 'human', id: maintainer },
        cancelReason: 'No longer needed',
      },
      changed: true,
    });
    const repeated = await request(f.project, maintainer, `/${subscription.id}/cancel`, {});
    expect(await repeated.json()).toMatchObject({ idempotent: true, changed: false });
    expect(
      await projectData.listProjectEventSubscriptionEvents(testEnv, f.project, {
        subscriptionId: subscription.id,
        visibility: { owner: subscription.owner, target: { sessionId: 'session' } },
      })
    ).toBeNull();
  });

  it.each(['policy', 'system', 'standing_watch'] as const)(
    'does not let a member revoke a %s-owned subscription',
    async (type) => {
      const f = await fixture();
      const subscription = await f.subscribe('session', type);
      expect((await request(f.project, f.owner, `/${subscription.id}/cancel`, {})).status).toBe(
        403
      );
      expect(
        await projectData.getProjectEventSubscription(testEnv, f.project, {
          subscriptionId: subscription.id,
        })
      ).toMatchObject({ state: 'active' });
    }
  );

  it('allows a maintainer to cancel a human-owned project subscription', async () => {
    const f = await fixture();
    const subscription = await f.subscribe('session', 'human');
    const maintainer = await f.member('maintainer');
    const response = await request(f.project, maintainer, `/${subscription.id}/cancel`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subscription: {
        owner: subscription.owner,
        cancelledBy: { type: 'human', id: maintainer },
        state: 'cancelled',
      },
    });
  });

  it('rejects identity overrides, malformed input and oversized request bodies before cancelling', async () => {
    const f = await fixture();
    const subscription = await f.subscribe('session');
    for (const body of [
      { cancelledBy: { type: 'policy', id: 'forged' } },
      { projectId: 'forged' },
      { reason: 42 },
      [],
    ]) {
      expect((await request(f.project, f.owner, `/${subscription.id}/cancel`, body)).status).toBe(
        400
      );
    }
    expect(
      (
        await request(f.project, f.owner, `/${subscription.id}/cancel`, {
          reason: 'x'.repeat(20_000),
        })
      ).status
    ).toBe(413);
    for (const query of [
      'state=unknown',
      'limit=-1',
      'limit=NaN',
      'ownerScope=all',
      'sessionId=',
    ]) {
      expect((await request(f.project, f.owner, `?${query}`)).status).toBe(400);
    }
    expect(
      await projectData.getProjectEventSubscription(testEnv, f.project, {
        subscriptionId: subscription.id,
      })
    ).toMatchObject({ state: 'active' });
  });
});
