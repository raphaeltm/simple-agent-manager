import type {
  ProjectScheduleMutationResult,
  ProjectStandingWatchMutationResult,
} from '@simple-agent-manager/shared';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { runScheduleAlarm } from '../../src/durable-objects/project-data/project-event-schedules-runner';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { projectScheduleRoutes } from '../../src/routes/project-schedules';
import { projectStandingWatchRoutes } from '../../src/routes/project-standing-watches';
import * as service from '../../src/services/project-data';
import { body, fixture } from './helpers/event-channels';
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
  app.route('/api/projects/:projectId/schedules', projectScheduleRoutes);
  app.route('/api/projects/:projectId/standing-watches', projectStandingWatchRoutes);
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

function request(sessionId: string, key = crypto.randomUUID()) {
  return {
    action: { kind: 'message_session', sessionId, prompt: 'Scheduled route message' },
    dueAt: Date.now() + 3_600_000,
    displayTimezone: 'UTC',
    idempotencyKey: key,
  };
}

describe('scheduled actions public boundaries', () => {
  it('uses all six real MCP tools with server-derived creator and versioned mutations', async () => {
    const f = await fixture();
    const input = request(f.sessionId);
    const created = body<ProjectScheduleMutationResult>(
      await f.tool('create_project_schedule', input)
    );
    expect(created.schedule).toMatchObject({
      creatorUserId: f.userId,
      creatorChatSessionId: f.sessionId,
      projectId: f.projectId,
      state: 'pending',
    });
    expect(
      body<ProjectScheduleMutationResult>(
        await f.tool('reconcile_project_schedule', {
          scheduleId: created.schedule.id,
          expectedVersion: created.schedule.version,
        })
      )
    ).toMatchObject({
      changed: false,
      recovery: { outcome: 'not_admitted' },
      schedule: { execution: { status: 'not_started' } },
    });
    expect(
      body<ProjectScheduleMutationResult>(await f.tool('create_project_schedule', input)).idempotent
    ).toBe(true);
    expect(
      body<{ schedule: { id: string } }>(
        await f.tool('get_project_schedule', { scheduleId: created.schedule.id })
      ).schedule.id
    ).toBe(created.schedule.id);
    expect(
      body<{ schedules: { id: string }[] }>(
        await f.tool('list_project_schedules', { sessionId: f.sessionId })
      ).schedules
    ).toEqual([expect.objectContaining({ id: created.schedule.id })]);
    const rescheduled = body<ProjectScheduleMutationResult>(
      await f.tool('reschedule_project_schedule', {
        scheduleId: created.schedule.id,
        expectedVersion: 1,
        dueAt: input.dueAt + 60_000,
      })
    );
    expect(rescheduled.schedule.version).toBe(2);
    expect(
      body<ProjectScheduleMutationResult>(
        await f.tool('cancel_project_schedule', {
          scheduleId: created.schedule.id,
          expectedVersion: 2,
        })
      ).schedule.state
    ).toBe('cancelled');
    expect(
      (await f.tool('create_project_schedule', { ...input, userId: 'forged' })).error
    ).toBeDefined();
    const other = await fixture();
    expect(
      (await other.tool('get_project_schedule', { scheduleId: created.schedule.id })).error
    ).toBeDefined();
  });

  it('authorizes member reads, rejects viewer writes and unauthenticated production routes', async () => {
    const f = await fixture();
    const viewer = crypto.randomUUID();
    await seedUser(viewer);
    await env.DATABASE.prepare(
      `INSERT INTO project_members (project_id,user_id,role,status,created_at,updated_at)
      VALUES (?,?,'viewer','active',datetime('now'),datetime('now'))`
    )
      .bind(f.projectId, viewer)
      .run();
    const response = await browser(
      f.projectId,
      f.userId,
      '/schedules',
      'POST',
      request(f.sessionId)
    );
    expect(response.status).toBe(201);
    const created = await response.json<ProjectScheduleMutationResult>();
    expect((await browser(f.projectId, viewer)).status).toBe(200);
    expect(
      (await browser(f.projectId, viewer, '/schedules', 'POST', request(f.sessionId))).status
    ).toBe(403);
    expect(
      (
        await browser(
          f.projectId,
          f.userId,
          `/schedules/${created.schedule.id}/reschedule`,
          'POST',
          {
            expectedVersion: 99,
            dueAt: Date.now() + 100_000,
          }
        )
      ).status
    ).toBe(409);
    expect((await browser(f.projectId, f.userId, '/schedules/missing')).status).toBe(404);
    expect(
      (await SELF.fetch(`https://api.test.example.com/api/projects/${f.projectId}/schedules`))
        .status
    ).toBe(401);
    await env.DATABASE.prepare(
      `UPDATE project_members SET status = 'suspended' WHERE project_id = ? AND user_id = ?`
    )
      .bind(f.projectId, viewer)
      .run();
    expect((await browser(f.projectId, viewer)).status).toBe(404);
  });

  it('creates a human policy through REST and pauses/revokes its canonical subscription', async () => {
    const f = await fixture();
    const createdResponse = await browser(f.projectId, f.userId, '/standing-watches', 'POST', {
      action: request(f.sessionId).action,
      filter: { version: 1, source: 'github' },
      idempotencyKey: crypto.randomUUID(),
      maxExecutions: 2,
      maxConcurrent: 1,
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<ProjectStandingWatchMutationResult>();
    expect(
      (
        await service.getProjectEventSubscription(testEnv, f.projectId, {
          subscriptionId: created.watch.subscriptionId,
        })
      )?.owner
    ).toMatchObject({ type: 'standing_watch', id: created.watch.id });
    const pausedResponse = await browser(
      f.projectId,
      f.userId,
      `/standing-watches/${created.watch.id}/pause`,
      'POST',
      {
        expectedVersion: 1,
        paused: true,
      }
    );
    expect(pausedResponse.status).toBe(200);
    const paused = await pausedResponse.json<ProjectStandingWatchMutationResult>();
    expect(paused.watch.state).toBe('paused');
    expect(
      (
        await browser(
          f.projectId,
          f.userId,
          `/standing-watches/${created.watch.id}/revoke`,
          'POST',
          {
            expectedVersion: paused.watch.version,
          }
        )
      ).status
    ).toBe(200);
    expect((await f.tool('create_project_standing_watch', {})).error).toBeDefined();
  });

  it('atomically records a due event and prompt using real workerd SQLite within the same chat', async () => {
    const f = await fixture();
    const created = await service.createProjectSchedule(testEnv, f.projectId, {
      userId: f.userId,
      creatorChatSessionId: f.sessionId,
      request: request(f.sessionId),
    });
    const result = await runInDurableObject(f.stub, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE project_schedules SET due_at = ?, next_attempt_at = ? WHERE id = ?`,
        Date.now() - 1,
        Date.now() - 1,
        created.schedule.id
      );
      await runScheduleAlarm(state.storage.sql, testEnv, {
        getProjectId: () => f.projectId,
        transactionSync: (callback) => state.storage.transactionSync(callback),
        waitUntil: () => {},
        recalculateAlarm: async () => {},
        scheduleSummarySync: () => {},
        broadcastEvent: () => {},
      });
      const schedule = await instance.getProjectSchedule({
        projectId: f.projectId,
        userId: f.userId,
        id: created.schedule.id,
      });
      const prompt = state.storage.sql
        .exec(
          `SELECT target_session_id, source_kind FROM session_inbox WHERE id = ?`,
          schedule?.deliveryId ?? ''
        )
        .toArray()[0];
      return { schedule, prompt };
    });
    expect(result.schedule).toMatchObject({ state: 'admitted', resultSessionId: f.sessionId });
    expect(result.schedule?.eventId).toEqual(expect.any(String));
    expect(result.prompt).toEqual({
      target_session_id: f.sessionId,
      source_kind: 'scheduled_action',
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE project_schedules SET state='ambiguous', next_attempt_at=NULL WHERE id=?`,
        created.schedule.id
      );
      state.storage.sql.exec(
        `UPDATE session_inbox SET delivery_state='ambiguous' WHERE id=?`,
        result.schedule!.deliveryId
      );
    });
    const unresolvedResponse = await browser(
      f.projectId,
      f.userId,
      `/schedules/${created.schedule.id}/reconcile`,
      'POST',
      { expectedVersion: created.schedule.version }
    );
    expect(unresolvedResponse.status).toBe(200);
    expect(await unresolvedResponse.json()).toMatchObject({
      changed: false,
      recovery: { outcome: 'unresolved' },
      schedule: { execution: { status: 'ambiguous', retrySubmissionAllowed: false } },
    });
    expect(
      (
        await browser(
          f.projectId,
          f.userId,
          `/schedules/${created.schedule.id}/reconcile`,
          'POST',
          { expectedVersion: created.schedule.version, retrySubmission: true }
        )
      ).status
    ).toBe(400);
    await runInDurableObject(f.stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE session_inbox SET delivery_state='acked' WHERE id=?`,
        result.schedule!.deliveryId
      );
    });
    const recovered = body<ProjectScheduleMutationResult>(
      await f.tool('reconcile_project_schedule', {
        scheduleId: created.schedule.id,
        expectedVersion: created.schedule.version,
      })
    );
    expect(recovered).toMatchObject({
      changed: true,
      recovery: { outcome: 'observed' },
      schedule: { deliveryId: result.schedule!.deliveryId, execution: { status: 'acked' } },
    });
    const persisted = await runInDurableObject(f.stub, async (_instance, state) => ({
      schedule: state.storage.sql
        .exec(
          'SELECT execution_finished_at, next_attempt_at FROM project_schedules WHERE id=?',
          created.schedule.id
        )
        .toArray()[0],
      deliveries: state.storage.sql
        .exec("SELECT id FROM session_inbox WHERE source_kind='scheduled_action'")
        .toArray(),
    }));
    expect(persisted.schedule).toMatchObject({
      execution_finished_at: expect.any(Number),
      next_attempt_at: null,
    });
    expect(persisted.deliveries).toEqual([{ id: result.schedule!.deliveryId }]);
    expect(
      (
        await browser(
          f.projectId,
          f.userId,
          `/schedules/${created.schedule.id}/reconcile`,
          'POST',
          { expectedVersion: created.schedule.version }
        )
      ).status
    ).toBe(409);
  });
});
