import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { ProjectEventDeliveryOutcomeList } from '@simple-agent-manager/shared';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { projectEventSubscriptionRoutes } from '../../src/routes/project-event-subscriptions';
import * as service from '../../src/services/project-data';
import { fixture } from './helpers/event-channels';
import { seedUser } from './helpers/seed-d1';
const testEnv = env as unknown as Env;

/** Substitute only browser login; member roles, REST/MCP, D1 and DO storage are real. */
function browser(
  projectId: string,
  userId: string,
  path = '/schedules',
  method = 'GET',
  value?: unknown
) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
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
    `https://api.test/api/projects/${projectId}${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value),
    },
    testEnv
  );
}


it('shows bounded actual transport outcomes to members without leaking event payloads or foreign projects', async () => {
  const f = await fixture();
  const subscription = await service.createProjectEventSubscription(testEnv, f.projectId, {
    owner: { type: 'agent', id: f.agentSessionId },
    filter: { version: 1, source: 'github', eventType: 'check_suite.completed' },
    idempotencyKey: crypto.randomUUID(),
    deliveryPreference: { requested: 'existing_session_prompt', resolved: 'recorded_not_injected',
      target: { sessionId: f.sessionId, taskId: f.taskId, agentId: f.agentSessionId } },
  });
  const path = `/event-subscriptions/${subscription.subscription.id}/deliveries`;
  expect(await (await browser(f.projectId, f.userId, path)).json()).toEqual({ deliveries: [], hasMore: false });
  for (let i = 0; i < 2; i++) {
    const event = await service.admitProjectEvent(testEnv, f.projectId, {
      source: 'github', eventType: 'check_suite.completed', subject: { type: 'pull_request', id: String(i) },
      severity: 'warning', deliveryKey: `delivery-${i}`, payloadFingerprint: `sha256:fingerprint-${i}`,
      metadata: { privateEvidence: 'MUST NOT APPEAR IN DELIVERY INSPECTION' },
      display: { title: 'Private title', summary: 'Private evidence' },
    });
    await service.createProjectEventDeliveryBatch(testEnv, f.projectId, {
      subscriptionId: subscription.subscription.id, matchIds: [event.matches[0]!.id],
      idempotencyKey: `batch-${i}`, requestedDelivery: 'existing_session_prompt',
      terminalReason: 'Unsupported delivery target',
    });
  }
  const viewer = crypto.randomUUID();
  await seedUser(viewer);
  await env.DATABASE.prepare(`INSERT INTO project_members (project_id,user_id,role,status,created_at,updated_at)
    VALUES (?,?,'viewer','active',datetime('now'),datetime('now'))`).bind(f.projectId,viewer).run();
  const response = await browser(f.projectId, viewer, `${path}?limit=1`);
  expect(response.status).toBe(200);
  const result = await response.json<ProjectEventDeliveryOutcomeList>();
  expect(result.hasMore).toBe(true);
  expect(result.deliveries).toHaveLength(1);
  expect(result.deliveries[0]).toMatchObject({ state: 'recorded_not_injected', deliveredVia: null,
    requestedDelivery: 'existing_session_prompt', terminalReason: 'Unsupported delivery target' });
  expect(Object.keys(result.deliveries[0]!).sort()).toEqual([
    'id', 'state', 'deliveryChannel', 'deliveredVia', 'requestedDelivery', 'resolvedDelivery',
    'createdAt', 'updatedAt', 'deliveredAt', 'ackedAt', 'terminalAt', 'terminalReason',
  ].sort());
  expect(JSON.stringify(result)).not.toContain('privateEvidence');
  expect(JSON.stringify(result)).not.toContain('MUST NOT APPEAR');
  expect((await browser(f.projectId, viewer, `${path}?limit=-1`)).status).toBe(400);
  expect((await browser(f.projectId, viewer, `${path}?subscriptionId=foreign`)).status).toBe(400);
  expect((await browser(f.projectId, viewer, '/event-subscriptions/missing/deliveries')).status).toBe(404);
  const other = await fixture();
  expect((await browser(other.projectId, other.userId, path)).status).toBe(404);
  await env.DATABASE.prepare("UPDATE project_members SET status='removed' WHERE project_id=? AND user_id=?").bind(f.projectId,viewer).run();
  expect((await browser(f.projectId, viewer, path)).status).toBe(404);
  expect((await SELF.fetch(`https://api.test/api/projects/${f.projectId}${path}`)).status).toBe(401);
});
