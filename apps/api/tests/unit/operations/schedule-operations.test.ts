/**
 * Connector schedule operations. The ProjectData DO's schedule calls are faked (their own
 * behaviour is covered by the DO tests) and every call's exact arguments are asserted.
 * Membership, recurring schedules (cron triggers), receipts and audit run against a real SQLite
 * engine, so project predicates are evaluated rather than assumed.
 */
import type { ProjectSchedule, ProjectScheduleMutationResult } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { ProjectScheduleNotFoundError } from '../../../src/durable-objects/project-data/project-event-schedules-storage';
import { ProjectEventValidationError } from '../../../src/durable-objects/project-data/project-events-contracts';
import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { OperationError } from '../../../src/operations/errors';
import { operationInputJsonSchema } from '../../../src/operations/registry';
import {
  samScheduleCancel,
  samScheduleCreate,
  samScheduleGet,
  samSchedulesList,
  samScheduleUpdate,
  scheduleCreateStartsWork,
  scheduleOperations,
} from '../../../src/operations/schedule-operations';
import type { OperationContext } from '../../../src/operations/types';
import { CONNECTOR_DEFAULTS } from '../../../src/services/connector-settings-definition';
import { applySqliteMigration, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('../../../src/services/project-data', () => ({
  getProjectSchedule: mocks.get,
  listProjectSchedules: mocks.list,
  createProjectSchedule: mocks.create,
  mutateProjectSchedule: mocks.mutate,
  recordActivityEvent: vi.fn(async () => undefined),
}));

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const SECRET = 'canary-secret-DO-NOT-EXPOSE';

function oneOff(overrides: Partial<ProjectSchedule> = {}): ProjectSchedule {
  return {
    id: 'sched-1',
    projectId: 'p',
    creatorUserId: 'owner',
    creatorChatSessionId: null,
    reason: 'Weekly report',
    action: {
      kind: 'start_session',
      prompt: 'Run the weekly report',
      agentProfileId: null,
      skillId: null,
    },
    state: 'pending',
    dueAt: Date.parse('2026-10-30T08:00:00.000Z'),
    displayTimezone: 'Europe/Paris',
    expiresAt: Date.parse('2026-10-31T08:00:00.000Z'),
    version: 1,
    idempotencyKey: 'connector:seed',
    createdAt: NOW,
    updatedAt: NOW,
    nextAttemptAt: Date.parse('2026-10-30T08:00:00.000Z'),
    attemptCount: 0,
    lastError: null,
    eventId: null,
    deliveryId: null,
    resultTaskId: null,
    resultSessionId: null,
    watchId: null,
    sourceEventId: null,
    execution: {
      kind: 'start_session',
      status: 'not_started',
      checkedAt: NOW,
      deliveryId: null,
      taskId: null,
      sessionId: null,
      receiptState: null,
      error: null,
      retrySubmissionAllowed: false,
      submissionDeadline: Date.parse('2026-10-31T08:00:00.000Z'),
    },
    ...overrides,
  };
}

function mutation(schedule: ProjectSchedule, changes: Partial<ProjectScheduleMutationResult> = {}) {
  return { schedule, changed: true, idempotent: false, actionAlreadyAdmitted: false, ...changes };
}

describe('connector schedule operations', () => {
  let sqlite: Database.Database;
  let env: Env;
  let byKey: Map<string, ProjectSchedule>;

  function ctx(userId = 'owner', overrides: Partial<OperationContext> = {}): OperationContext {
    return {
      env,
      requestId: 'test',
      connectorSettings: CONNECTOR_DEFAULTS,
      actor: {
        userId,
        via: 'connector',
        clientName: 'Claude',
        scopes: new Set(['sam.read', 'sam.write']),
      },
      ...overrides,
    };
  }
  /** As the Connector adapter does: the requestKey argument is also the context key. */
  function keyed(requestKey: string, userId = 'owner'): OperationContext {
    return ctx(userId, { idempotencyKey: requestKey });
  }
  const triggerRow = (id: string) =>
    sqlite
      .prepare(
        `SELECT project_id, user_id, name, description, status, source_type, cron_expression,
          cron_timezone, prompt_template, task_mode, next_fire_at, auto_pause_reset_sequence
         FROM triggers WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
  const receipts = () =>
    sqlite.prepare('SELECT state FROM cli_operation_receipts').all() as Array<{ state: string }>;
  async function refusal(promise: Promise<unknown>): Promise<OperationError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof OperationError) return error;
      throw error;
    }
    throw new Error('expected the operation to be refused');
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.users,
      schema.projects,
      schema.projectMembers,
      schema.triggers,
      schema.triggerExecutions,
      schema.agentProfiles,
      schema.skills,
    ]);
    for (const name of ['0189_cli_operation_receipts.sql', '0191_connector_execution.sql']) {
      // Production migrations as fixtures, so receipts and budgets run their real SQL.
      applySqliteMigration(sqlite, new URL(`../../../src/db/migrations/${name}`, import.meta.url));
    }
    sqlite.exec(`INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'),
        ('maint','Maintainer','m@example.com'), ('viewer','Viewer','v@example.com'),
        ('outsider','Outsider','x@example.com');
      INSERT INTO projects (id, name) VALUES ('p','Project'), ('other','Other');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES ('p','owner','owner','active'),
        ('p','maint','maintainer','active'), ('p','viewer','viewer','active'),
        ('other','outsider','owner','active');`);
    const trigger = sqlite.prepare(`INSERT INTO triggers (id, project_id, user_id, name, status,
      source_type, cron_expression, cron_timezone, skip_if_running, prompt_template, task_mode,
      max_concurrent, trigger_count, next_execution_sequence, next_fire_at, last_triggered_at,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'task', 1, 2, 5, ?, NULL, ?, ?)`);
    trigger.run(
      'trig-p',
      'p',
      'owner',
      'Nightly',
      'active',
      'cron',
      '0 2 * * *',
      'UTC',
      'Summarize the night',
      '2026-10-21T02:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z'
    );
    trigger.run(
      'trig-other',
      'other',
      'outsider',
      'Secret nightly',
      'active',
      'cron',
      '0 3 * * *',
      'UTC',
      SECRET,
      '2026-10-21T03:00:00.000Z',
      '2026-10-02T00:00:00.000Z',
      '2026-10-02T00:00:00.000Z'
    );
    trigger.run(
      'hook-p',
      'p',
      'owner',
      'Hook',
      'active',
      'webhook',
      null,
      null,
      'Handle hook',
      null,
      '2026-10-03T00:00:00.000Z',
      '2026-10-03T00:00:00.000Z'
    );
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
    byKey = new Map();
    mocks.get.mockResolvedValue(null);
    mocks.list.mockResolvedValue({ schedules: [], nextCursor: null });
    // A faithful-enough DO create: replays by idempotency key, as `createSchedule` does.
    mocks.create.mockImplementation(
      async (
        _env: Env,
        projectId: string,
        input: { userId: string; request: Record<string, unknown> }
      ) => {
        const request = input.request as {
          action: ProjectSchedule['action'];
          dueAt: number;
          displayTimezone: string;
          idempotencyKey: string;
          reason?: string;
          expiresAt?: number;
        };
        const existing = byKey.get(request.idempotencyKey);
        if (existing) return mutation(existing, { changed: false, idempotent: true });
        const created = oneOff({
          id: `sched-${byKey.size + 1}`,
          projectId,
          creatorUserId: input.userId,
          action: request.action,
          dueAt: request.dueAt,
          displayTimezone: request.displayTimezone,
          reason: request.reason ?? null,
          idempotencyKey: request.idempotencyKey,
          ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
        });
        byKey.set(request.idempotencyKey, created);
        return mutation(created);
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sqlite.close();
  });

  describe('creating a one-off schedule', () => {
    it('sends the DO the exact UTC instant of a local time and keeps the zone for display', async () => {
      const result = await samScheduleCreate.run(keyed('k1'), {
        projectId: 'p',
        requestKey: 'k1',
        runAt: '2026-11-01T01:30',
        timezone: 'america/new_york',
        disambiguation: 'later',
        reason: 'Weekly report',
        action: { kind: 'start_session', prompt: 'Run the weekly report' },
      });
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.create).toHaveBeenCalledWith(env, 'p', {
        userId: 'owner',
        creatorChatSessionId: null,
        creator: 'person',
        request: {
          action: {
            kind: 'start_session',
            prompt: 'Run the weekly report',
            agentProfileId: null,
            skillId: null,
          },
          // 01:30 happens twice in New York that night; "later" is the EST one.
          dueAt: Date.parse('2026-11-01T06:30:00.000Z'),
          displayTimezone: 'America/New_York',
          idempotencyKey: 'connector:k1',
          reason: 'Weekly report',
        },
      });
      expect(result).toMatchObject({
        kind: 'one_off',
        scheduleId: 'sched-1',
        dueAt: '2026-11-01T06:30:00.000Z',
        localDueAt: '2026-11-01T01:30:00',
        timezone: 'America/New_York',
        utcOffsetMinutes: -300,
        action: { kind: 'start_session', taskMode: 'conversation' },
        timeResolution: { ambiguousLocalTime: true, resolvedAs: 'later' },
        receipt: { accepted: true, idempotentReplay: false, meaning: 'scheduled_not_started' },
        phases: {
          accepted: true,
          admitted: false,
          executionStarted: false,
          taskOutcome: 'no_task',
          ownerNotification: 'not_tracked',
        },
        link: 'https://app.example.test/projects/p/automation/schedule/sched-1',
      });
    });

    it('replays the saved receipt for a repeated requestKey and refuses a different request on it', async () => {
      const input = {
        projectId: 'p',
        requestKey: 'k1',
        runAt: '2026-10-30T09:00:00+01:00',
        action: { kind: 'start_session' as const, prompt: 'Run the weekly report' },
      };
      const first = await samScheduleCreate.run(keyed('k1'), input);
      const second = await samScheduleCreate.run(keyed('k1'), input);
      expect(second).toEqual(first);
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(receipts()).toEqual([{ state: 'completed' }]);
      const conflict = await refusal(
        samScheduleCreate.run(keyed('k1'), { ...input, runAt: '2026-10-30T10:00:00+01:00' })
      );
      expect(conflict.code).toBe('conflict');
      expect(mocks.create).toHaveBeenCalledTimes(1);
    });

    it("surfaces the DO's own idempotent replay when no Connector receipt intervenes", async () => {
      const web = ctx('owner', {
        idempotencyKey: 'k2',
        actor: { userId: 'owner', via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
      });
      const input = {
        projectId: 'p',
        runAt: '2026-10-30T09:00:00Z',
        action: { kind: 'start_session' as const, prompt: 'Run it' },
      };
      const first = await samScheduleCreate.run(web, input);
      const second = await samScheduleCreate.run(web, input);
      expect(mocks.create).toHaveBeenCalledTimes(2);
      for (const call of mocks.create.mock.calls)
        expect(call[2].request.idempotencyKey).toBe('connector:k2');
      expect(first.receipt.idempotentReplay).toBe(false);
      expect(second).toMatchObject({
        scheduleId: first.scheduleId,
        receipt: { idempotentReplay: true },
      });
    });

    it('namespaces every DO key, so none reaches the reserved provider-limit: prefix', async () => {
      const action = { kind: 'start_session' as const, prompt: 'Run it' };
      await samScheduleCreate.run(keyed('provider-limit:abc'), {
        projectId: 'p',
        requestKey: 'provider-limit:abc',
        runAt: '2026-10-30T09:00:00Z',
        action,
      });
      await samScheduleCreate.run(ctx(), { projectId: 'p', runAt: '2026-10-30T09:00:00Z', action });
      await samScheduleCreate.run(ctx(), { projectId: 'p', runAt: '2026-10-30T09:00:00Z', action });
      const keys = mocks.create.mock.calls.map((call) => String(call[2].request.idempotencyKey));
      expect(keys[0]).toBe('connector:provider-limit:abc');
      expect(keys[1]).toMatch(/^connector:auto:[0-9a-f-]{36}$/);
      // Without a requestKey a retry is a new schedule: the two keys differ.
      expect(keys[2]).not.toBe(keys[1]);
      for (const key of keys) expect(key.startsWith('provider-limit:')).toBe(false);
    });

    it('maps message_session to the DO message action and start_session to new work', async () => {
      const message = await samScheduleCreate.run(ctx(), {
        projectId: 'p',
        runAt: '2026-10-30T09:00:00Z',
        timezone: 'Europe/Paris',
        action: { kind: 'message_session', sessionId: 'chat-1', message: 'Any update?' },
      });
      expect(mocks.create.mock.calls[0]?.[2].request.action).toEqual({
        kind: 'message_session',
        sessionId: 'chat-1',
        prompt: 'Any update?',
      });
      expect(message).toMatchObject({
        action: { kind: 'message_session', targetSessionId: 'chat-1' },
        localDueAt: '2026-10-30T10:00:00',
        phases: { taskOutcome: 'not_applicable' },
        resultLink: 'https://app.example.test/projects/p/chat/chat-1',
      });
      await samScheduleCreate.run(ctx(), {
        projectId: 'p',
        runAt: '2026-10-30T09:00:00Z',
        action: { kind: 'start_session', prompt: 'Go', agentProfileId: 'prof', skillId: 'skill' },
      });
      expect(mocks.create.mock.calls[1]?.[2].request.action).toEqual({
        kind: 'start_session',
        prompt: 'Go',
        agentProfileId: 'prof',
        skillId: 'skill',
      });
      const taskMode = await refusal(
        samScheduleCreate.run(ctx(), {
          projectId: 'p',
          runAt: '2026-10-30T09:00:00Z',
          action: { kind: 'start_session', prompt: 'Go', taskMode: 'task' },
        })
      );
      expect(taskMode.code).toBe('invalid_input');
      expect(mocks.create).toHaveBeenCalledTimes(2);
    });

    it('refuses times it would run at once or cannot hold, before any receipt exists', async () => {
      const action = { kind: 'start_session' as const, prompt: 'Go' };
      const past = await refusal(
        samScheduleCreate.run(keyed('late'), {
          projectId: 'p',
          requestKey: 'late',
          runAt: '2026-10-20T11:59:00Z',
          action,
        })
      );
      expect(past.message).toContain('not in the future');
      const far = await refusal(
        samScheduleCreate.run(ctx(), { projectId: 'p', runAt: '2027-01-01T00:00:00Z', action })
      );
      expect(far.message).toContain('scheduling horizon');
      const gap = await refusal(
        samScheduleCreate.run(ctx(), {
          projectId: 'p',
          runAt: '2026-03-29T02:30',
          timezone: 'Europe/Paris',
          action,
        })
      );
      expect(gap.message).toContain('first valid time');
      const neither = await refusal(samScheduleCreate.run(ctx(), { projectId: 'p', action }));
      expect(neither.message).toContain('exactly one of runAt');
      expect(mocks.create).not.toHaveBeenCalled();
      expect(receipts()).toEqual([]);
    });

    it('frees the requestKey when the DO refuses before writing, and keeps it reserved when uncertain', async () => {
      const input = {
        projectId: 'p',
        requestKey: 'retry',
        runAt: '2026-10-30T09:00:00Z',
        action: { kind: 'message_session' as const, sessionId: 'chat-1', message: 'Ping' },
      };
      mocks.create.mockRejectedValueOnce(
        new ProjectEventValidationError(
          'Scheduled target session is no longer active or recoverable'
        )
      );
      expect((await refusal(samScheduleCreate.run(keyed('retry'), input))).code).toBe(
        'invalid_input'
      );
      expect(receipts()).toEqual([]);
      await expect(samScheduleCreate.run(keyed('retry'), input)).resolves.toMatchObject({
        receipt: { accepted: true },
      });
      expect(mocks.create).toHaveBeenCalledTimes(2);

      mocks.create.mockRejectedValueOnce(new Error('Durable Object reset'));
      const uncertain = { ...input, requestKey: 'uncertain' };
      await expect(samScheduleCreate.run(keyed('uncertain'), uncertain)).rejects.toThrow('reset');
      const blocked = await refusal(samScheduleCreate.run(keyed('uncertain'), uncertain));
      expect(blocked.code).toBe('conflict');
      expect(blocked.message).toContain('uncertain');
      expect(mocks.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('creating a recurring schedule', () => {
    it('creates a cron trigger in the project with the canonical zone and the next run', async () => {
      const created = await samScheduleCreate.run(keyed('r1', 'maint'), {
        projectId: 'p',
        requestKey: 'r1',
        cron: '0 9 * * 1-5',
        timezone: 'europe/paris',
        name: 'Weekday triage',
        reason: 'Morning triage',
        action: { kind: 'start_session', prompt: 'Triage new issues', taskMode: 'conversation' },
      });
      expect(triggerRow(created.scheduleId)).toEqual({
        project_id: 'p',
        user_id: 'maint',
        name: 'Weekday triage',
        description: 'Morning triage',
        status: 'active',
        source_type: 'cron',
        cron_expression: '0 9 * * 1-5',
        cron_timezone: 'Europe/Paris',
        prompt_template: 'Triage new issues',
        task_mode: 'conversation',
        // Tuesday 14:00 in Paris, so the next run is Wednesday 09:00 Paris time.
        next_fire_at: '2026-10-21T07:00:00.000Z',
        auto_pause_reset_sequence: null,
      });
      expect(created).toMatchObject({
        kind: 'recurring',
        status: 'active',
        nextRunAt: '2026-10-21T07:00:00.000Z',
        localNextRunAt: '2026-10-21T09:00:00',
        creator: { userId: 'maint', isYou: true },
        runsAsUserId: 'maint',
        expiresAt: null,
        receipt: { accepted: true, idempotentReplay: false, meaning: 'scheduled_not_started' },
      });
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it('refuses a duplicate name as a conflict without spending the requestKey', async () => {
      const input = {
        projectId: 'p',
        requestKey: 'dup',
        cron: '0 9 * * *',
        name: 'Nightly',
        action: { kind: 'start_session' as const, prompt: 'Again' },
      };
      expect((await refusal(samScheduleCreate.run(keyed('dup'), input))).code).toBe('conflict');
      expect(receipts()).toEqual([]);
      sqlite.exec("UPDATE triggers SET name = 'Old nightly' WHERE id = 'trig-p'");
      await expect(samScheduleCreate.run(keyed('dup'), input)).resolves.toMatchObject({
        name: 'Nightly',
      });
    });

    it('refuses a recurring message, a missing name and a cron that fires too often', async () => {
      const base = { projectId: 'p', cron: '0 9 * * *', name: 'Ping' };
      const message = await refusal(
        samScheduleCreate.run(ctx(), {
          ...base,
          action: { kind: 'message_session', sessionId: 'chat-1', message: 'Hi' },
        })
      );
      expect(message.message).toContain('schedule it once with runAt');
      const unnamed = await refusal(
        samScheduleCreate.run(ctx(), {
          ...base,
          name: undefined,
          action: { kind: 'start_session', prompt: 'Go' },
        })
      );
      expect(unnamed.message).toContain('name');
      const often = await refusal(
        samScheduleCreate.run(ctx(), {
          ...base,
          cron: '* * * * *',
          action: { kind: 'start_session', prompt: 'Go' },
        })
      );
      expect(often.code).toBe('invalid_input');
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM triggers WHERE project_id = 'p'").get()
      ).toEqual({ n: 2 });
    });
  });

  describe('authorization', () => {
    it('lets a viewer read schedules but not write them', async () => {
      await expect(samSchedulesList.run(ctx('viewer'), { projectId: 'p' })).resolves.toMatchObject({
        recurring: [expect.objectContaining({ scheduleId: 'trig-p' })],
      });
      const create = await refusal(
        samScheduleCreate.run(ctx('viewer'), {
          projectId: 'p',
          runAt: '2026-10-30T09:00:00Z',
          action: { kind: 'start_session', prompt: 'Go' },
        })
      );
      expect(create.code).toBe('forbidden');
      const pause = await refusal(
        samScheduleUpdate.run(ctx('viewer'), { projectId: 'p', scheduleId: 'trig-p', paused: true })
      );
      expect(pause.code).toBe('forbidden');
      expect(mocks.create).not.toHaveBeenCalled();
      expect(triggerRow('trig-p')?.status).toBe('active');
    });

    it('refuses a missing write scope, a non-member and a workspace token for another project', async () => {
      const readOnly = ctx('owner', {
        actor: { userId: 'owner', via: 'connector', scopes: new Set(['sam.read']) },
      });
      expect(
        (
          await refusal(
            samScheduleCancel.run(readOnly, {
              projectId: 'p',
              scheduleId: 'sched-1',
              expectedVersion: 1,
            })
          )
        ).code
      ).toBe('forbidden');
      expect((await refusal(samSchedulesList.run(ctx('outsider'), { projectId: 'p' }))).code).toBe(
        'not_found'
      );
      const workspace = ctx('owner', {
        actor: {
          userId: 'owner',
          via: 'workspace-agent',
          scopes: new Set(['sam.read', 'sam.write']),
          workspace: { workspaceId: 'ws', projectId: 'other' },
        },
      });
      for (const run of [
        () => samSchedulesList.run(workspace, { projectId: 'p' }),
        () => samScheduleGet.run(workspace, { projectId: 'p', scheduleId: 'trig-p' }),
        () =>
          samScheduleCreate.run(workspace, {
            projectId: 'p',
            runAt: '2026-10-30T09:00:00Z',
            action: { kind: 'start_session', prompt: 'Go' },
          }),
      ]) {
        const error = await refusal(run());
        expect(error.code).toBe('forbidden');
        expect(error.message).toContain('workspace token');
      }
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('reading one schedule', () => {
    it('falls back to a cron trigger only within the requested project', async () => {
      // Owner-path control: the project's own recurring schedule is found.
      sqlite.exec(`INSERT INTO trigger_executions (id, trigger_id, project_id, status, skip_reason,
          task_id, error_message, scheduled_at, created_at) VALUES
        ('run-1','trig-p','p','failed',NULL,'task-1','${SECRET}','2026-10-19T02:00:00.000Z','2026-10-19T02:00:01.000Z'),
        ('run-2','trig-p','p','skipped','still_running',NULL,NULL,'2026-10-20T02:00:00.000Z','2026-10-20T02:00:01.000Z'),
        ('run-x','trig-other','other','completed',NULL,'task-x',NULL,'2026-10-20T03:00:00.000Z','2026-10-20T03:00:01.000Z')`);
      const own = await samScheduleGet.run(ctx(), { projectId: 'p', scheduleId: 'trig-p' });
      expect(own).toMatchObject({
        kind: 'recurring',
        scheduleId: 'trig-p',
        cron: '0 2 * * *',
        nextRunAt: '2026-10-21T02:00:00.000Z',
        runCount: 2,
        recentRuns: [
          { runId: 'run-2', status: 'skipped', skipReason: 'still_running', taskId: null },
          { runId: 'run-1', status: 'failed', taskId: 'task-1', error: { code: 'RUN_ERROR' } },
        ],
        moreRuns: false,
        link: 'https://app.example.test/projects/p/automation/trigger/trig-p',
      });
      expect(JSON.stringify(own)).not.toContain(SECRET);
      expect(mocks.get).toHaveBeenCalledWith(env, 'p', { userId: 'owner', id: 'trig-p' });

      // Attack: another project's trigger id, asked for through this project.
      const foreign = await refusal(
        samScheduleGet.run(ctx(), { projectId: 'p', scheduleId: 'trig-other' })
      );
      expect(foreign.code).toBe('not_found');
      // A non-cron trigger is not a schedule.
      expect(
        (await refusal(samScheduleGet.run(ctx(), { projectId: 'p', scheduleId: 'hook-p' }))).code
      ).toBe('not_found');
    });

    it('separates acceptance, admission, execution start and task outcome without echoing errors', async () => {
      const startedTask = (status: string) =>
        oneOff({
          state: 'admitted',
          eventId: 'event-1',
          lastError: SECRET,
          execution: {
            ...oneOff().execution!,
            status,
            taskId: 'task-9',
            sessionId: 'chat-9',
            receiptState: 'submitted',
            error: SECRET,
          },
        });
      const cases: Array<[ProjectSchedule, Record<string, unknown>]> = [
        [
          startedTask('queued'),
          { admitted: true, executionStarted: false, taskOutcome: 'not_finished' },
        ],
        [startedTask('in_progress'), { executionStarted: true, taskOutcome: 'not_finished' }],
        [startedTask('completed'), { executionStarted: true, taskOutcome: 'completed' }],
        [startedTask('failed'), { executionStarted: 'unknown', taskOutcome: 'failed' }],
        [startedTask('unavailable'), { executionStarted: 'unknown', taskOutcome: 'unknown' }],
      ];
      for (const delivery of ['acked', 'delivered', 'retry_wait'])
        cases.push([
          oneOff({
            state: 'admitted',
            eventId: 'event-2',
            deliveryId: 'delivery-2',
            action: { kind: 'message_session', sessionId: 'chat-2', prompt: 'Ping' },
            execution: { ...oneOff().execution!, kind: 'message_session', status: delivery },
          }),
          {
            executionStarted: { acked: true, delivered: 'unknown', retry_wait: false }[delivery],
            taskOutcome: 'not_applicable',
          },
        ]);
      for (const [schedule, phases] of cases) {
        mocks.get.mockResolvedValueOnce(schedule);
        const read = await samScheduleGet.run(ctx(), { projectId: 'p', scheduleId: schedule.id });
        expect(read.phases).toMatchObject({
          accepted: true,
          ownerNotification: 'not_tracked',
          ...phases,
        });
        expect(JSON.stringify(read)).not.toContain(SECRET);
      }
      mocks.get.mockResolvedValueOnce(startedTask('in_progress'));
      expect(
        await samScheduleGet.run(ctx(), { projectId: 'p', scheduleId: 'sched-1' })
      ).toMatchObject({
        lastError: { code: 'SCHEDULE_ERROR', detail: expect.any(String) },
        execution: {
          source: 'task',
          status: 'in_progress',
          taskId: 'task-9',
          receiptState: 'submitted',
        },
        resultLink: 'https://app.example.test/projects/p/chat/chat-9',
        prompt: { untrustedContent: true, truncated: false },
      });
      // A cancellation stores the canceller's reason where errors go; it is not an error.
      mocks.get.mockResolvedValueOnce(oneOff({ state: 'cancelled', lastError: SECRET }));
      expect(
        (await samScheduleGet.run(ctx(), { projectId: 'p', scheduleId: 'sched-1' })).lastError
      ).toBeNull();
    });
  });

  describe('listing schedules', () => {
    it('skips an unreadable row with a logged id instead of failing the page', async () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      mocks.list.mockResolvedValue({
        schedules: [
          oneOff({ id: 'good-1' }),
          oneOff({ id: 'bad-1', displayTimezone: 'Not/AZone' }),
          oneOff({ id: 'good-2' }),
        ],
        nextCursor: null,
      });
      sqlite.exec(`INSERT INTO triggers (id, project_id, user_id, name, status, source_type,
        cron_expression, cron_timezone, prompt_template, trigger_count, next_fire_at, created_at, updated_at)
        VALUES ('trig-bad','p','owner','Broken','active','cron','0 4 * * *','Not/AZone','x',0,
          '2026-10-21T04:00:00.000Z','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')`);
      const page = await samSchedulesList.run(ctx(), { projectId: 'p' });
      expect(page.oneOff?.map((item) => item.scheduleId)).toEqual(['good-1', 'good-2']);
      expect(page.recurring?.map((item) => item.scheduleId)).toEqual(['trig-p']);
      expect(page.unreadableRows).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        'connector.schedule_row_skipped',
        expect.objectContaining({ kind: 'one_off', scheduleId: 'bad-1', error: expect.any(String) })
      );
      expect(warn).toHaveBeenCalledWith(
        'connector.schedule_row_skipped',
        expect.objectContaining({ kind: 'recurring', scheduleId: 'trig-bad' })
      );

      mocks.list.mockResolvedValue({
        schedules: [oneOff({ id: 'bad-1', displayTimezone: 'Not/AZone' })],
        nextCursor: null,
      });
      await expect(
        samSchedulesList.run(ctx(), { projectId: 'p', kind: 'one_off' })
      ).resolves.toEqual({
        oneOff: [],
        recurring: null,
        nextCursor: null,
        unreadableRows: 1,
      });
    });

    it('pages both sources independently with a cursor bound to its project and filter', async () => {
      sqlite.exec(`INSERT INTO triggers (id, project_id, user_id, name, status, source_type,
        cron_expression, cron_timezone, prompt_template, trigger_count, next_fire_at, created_at, updated_at)
        VALUES ('trig-new','p','maint','Hourly','paused','cron','0 * * * *','UTC','Check',0,NULL,
          '2026-10-10T00:00:00.000Z','2026-10-10T00:00:00.000Z')`);
      mocks.list
        .mockResolvedValueOnce({ schedules: [oneOff({ id: 'a' })], nextCursor: 'do-cursor-1' })
        .mockResolvedValueOnce({ schedules: [oneOff({ id: 'b' })], nextCursor: null });
      const first = await samSchedulesList.run(ctx(), { projectId: 'p', limit: 1 });
      expect(first.oneOff?.map((item) => item.scheduleId)).toEqual(['a']);
      expect(first.recurring?.map((item) => item.scheduleId)).toEqual(['trig-new']);
      expect(first.recurring?.[0]).toMatchObject({
        status: 'paused',
        nextRunAt: null,
        creator: { isYou: false },
      });
      expect(mocks.list).toHaveBeenLastCalledWith(env, 'p', { userId: 'owner', limit: 1 });

      const second = await samSchedulesList.run(ctx(), {
        projectId: 'p',
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(mocks.list).toHaveBeenLastCalledWith(env, 'p', {
        userId: 'owner',
        limit: 1,
        cursor: 'do-cursor-1',
      });
      expect(second.oneOff?.map((item) => item.scheduleId)).toEqual(['b']);
      expect(second.recurring?.map((item) => item.scheduleId)).toEqual(['trig-p']);
      expect(second.nextCursor).toBeNull();

      const misuse = await refusal(
        samSchedulesList.run(ctx(), {
          projectId: 'p',
          kind: 'recurring',
          cursor: first.nextCursor ?? undefined,
        })
      );
      expect(misuse.code).toBe('invalid_input');
    });

    it('lists only one-off schedules for a chat, and previews prompts as untrusted text', async () => {
      mocks.list.mockResolvedValue({
        schedules: [
          oneOff({
            action: {
              kind: 'start_session',
              prompt: 'x'.repeat(5_000),
              agentProfileId: null,
              skillId: null,
            },
          }),
        ],
        nextCursor: null,
      });
      const page = await samSchedulesList.run(ctx(), { projectId: 'p', sessionId: 'chat-1' });
      expect(mocks.list).toHaveBeenCalledWith(env, 'p', {
        userId: 'owner',
        limit: 10,
        sessionId: 'chat-1',
      });
      expect(page.recurring).toBeNull();
      expect(page.oneOff?.[0]?.prompt).toMatchObject({ truncated: true, untrustedContent: true });
      expect(page.oneOff?.[0]?.prompt.text).toContain('sam_schedule_get');
    });
  });

  describe('updating a schedule', () => {
    it('reschedules a one-off at its own zone, and requires a version and a time', async () => {
      mocks.get.mockResolvedValue(oneOff({ displayTimezone: 'Europe/Paris' }));
      mocks.mutate.mockImplementation(async (_env, _projectId, input) =>
        mutation(oneOff({ version: 2, dueAt: input.request.dueAt }))
      );
      const result = await samScheduleUpdate.run(ctx(), {
        projectId: 'p',
        scheduleId: 'sched-1',
        expectedVersion: 1,
        runAt: '2026-10-30T09:00',
      });
      expect(mocks.mutate).toHaveBeenCalledWith(env, 'p', {
        userId: 'owner',
        id: 'sched-1',
        operation: 'reschedule',
        // 09:00 Paris after the clocks went back is 08:00 UTC.
        request: {
          expectedVersion: 1,
          dueAt: Date.parse('2026-10-30T08:00:00.000Z'),
          displayTimezone: 'Europe/Paris',
        },
      });
      expect(result).toMatchObject({
        version: 2,
        localDueAt: '2026-10-30T09:00:00',
        receipt: { changed: true },
      });

      for (const [input, text] of [
        [{ runAt: '2026-10-30T09:00' }, 'expectedVersion'],
        [{ expectedVersion: 1 }, 'runAt is required'],
        [{ expectedVersion: 1, paused: true }, 'cannot be paused'],
        [{ expectedVersion: 1, cron: '0 9 * * *' }, 'cannot become recurring'],
      ] as const) {
        const error = await refusal(
          samScheduleUpdate.run(ctx(), { projectId: 'p', scheduleId: 'sched-1', ...input })
        );
        expect(error.message).toContain(text);
      }
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
    });

    it('pauses and resumes a recurring schedule through the shared status rules', async () => {
      const paused = await samScheduleUpdate.run(keyed('pause'), {
        projectId: 'p',
        scheduleId: 'trig-p',
        requestKey: 'pause',
        paused: true,
      });
      expect(paused).toMatchObject({
        status: 'paused',
        nextRunAt: null,
        receipt: { changed: true },
      });
      expect(triggerRow('trig-p')).toMatchObject({ status: 'paused', next_fire_at: null });

      const resumed = await samScheduleUpdate.run(ctx(), {
        projectId: 'p',
        scheduleId: 'trig-p',
        paused: false,
        cron: '30 18 * * *',
        timezone: 'America/New_York',
      });
      expect(triggerRow('trig-p')).toMatchObject({
        status: 'active',
        cron_expression: '30 18 * * *',
        cron_timezone: 'America/New_York',
        // From the new expression and zone, not the stored ones.
        next_fire_at: '2026-10-20T22:30:00.000Z',
        auto_pause_reset_sequence: 5,
      });
      expect(resumed).toMatchObject({
        localNextRunAt: '2026-10-20T18:30:00',
        receipt: { changed: true },
      });
      expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('treats resuming an active schedule as a no-op so a due run is not skipped', async () => {
      sqlite.exec(
        "UPDATE triggers SET next_fire_at = '2026-10-20T11:59:00.000Z' WHERE id = 'trig-p'"
      );
      const result = await samScheduleUpdate.run(ctx(), {
        projectId: 'p',
        scheduleId: 'trig-p',
        paused: false,
      });
      expect(result.receipt).toEqual({ changed: false });
      expect(triggerRow('trig-p')).toMatchObject({
        next_fire_at: '2026-10-20T11:59:00.000Z',
        auto_pause_reset_sequence: null,
      });
    });

    it('loses to a disable that lands between the read and the write, without spending the key', async () => {
      const database = env.DATABASE;
      // Owns the ordering: the disable commits after preflight read the schedule as active,
      // at the moment the receipt is reserved and just before the guarded write.
      env.DATABASE = {
        ...database,
        prepare: (query: string) => {
          if (query.includes('INSERT OR IGNORE INTO cli_operation_receipts'))
            sqlite.exec("UPDATE triggers SET status = 'disabled' WHERE id = 'trig-p'");
          return database.prepare(query);
        },
      } as D1Database;
      const error = await refusal(
        samScheduleUpdate.run(keyed('race'), {
          projectId: 'p',
          scheduleId: 'trig-p',
          requestKey: 'race',
          paused: true,
        })
      );
      expect(error.code).toBe('conflict');
      expect(triggerRow('trig-p')).toMatchObject({
        status: 'disabled',
        next_fire_at: '2026-10-21T02:00:00.000Z',
      });
      expect(receipts()).toEqual([]);
    });

    it('leaves a schedule SAM disabled alone, and refuses one-off fields on a recurring one', async () => {
      sqlite.exec(
        "UPDATE triggers SET status = 'disabled', credential_blocked_reason = 'member_removed' WHERE id = 'trig-p'"
      );
      const disabled = await refusal(
        samScheduleUpdate.run(ctx(), { projectId: 'p', scheduleId: 'trig-p', paused: false })
      );
      expect(disabled.code).toBe('conflict');
      expect(triggerRow('trig-p')?.status).toBe('disabled');
      sqlite.exec("UPDATE triggers SET status = 'active' WHERE id = 'trig-p'");
      const version = await refusal(
        samScheduleUpdate.run(ctx(), {
          projectId: 'p',
          scheduleId: 'trig-p',
          expectedVersion: 1,
          paused: true,
        })
      );
      expect(version.message).toContain('expectedVersion apply to one-off schedules');
      expect(triggerRow('trig-p')?.status).toBe('active');
    });
  });

  describe('cancelling a schedule', () => {
    it('cancels a one-off with the exact version and says whether it can still run', async () => {
      mocks.mutate.mockResolvedValueOnce(
        mutation(oneOff({ state: 'cancelled', version: 2, lastError: 'No longer needed' }))
      );
      const cancelled = await samScheduleCancel.run(ctx(), {
        projectId: 'p',
        scheduleId: 'sched-1',
        expectedVersion: 1,
        reason: 'No longer needed',
      });
      expect(mocks.mutate).toHaveBeenCalledWith(env, 'p', {
        userId: 'owner',
        id: 'sched-1',
        operation: 'cancel',
        request: { expectedVersion: 1, reason: 'No longer needed' },
      });
      expect(cancelled).toMatchObject({
        state: 'cancelled',
        lastError: null,
        receipt: { cancelled: true, changed: true, meaning: 'cancelled_will_not_run' },
      });

      mocks.mutate.mockResolvedValueOnce(
        mutation(oneOff({ state: 'admitted', eventId: 'event-1' }), {
          changed: false,
          actionAlreadyAdmitted: true,
        })
      );
      expect(
        await samScheduleCancel.run(ctx(), {
          projectId: 'p',
          scheduleId: 'sched-1',
          expectedVersion: 1,
        })
      ).toMatchObject({
        receipt: {
          cancelled: false,
          actionAlreadyAdmitted: true,
          meaning: 'already_admitted_not_retracted',
        },
      });
    });

    it('refuses to cancel a recurring schedule without spending the requestKey', async () => {
      mocks.mutate.mockRejectedValue(new ProjectScheduleNotFoundError());
      const input = { projectId: 'p', scheduleId: 'trig-p', expectedVersion: 1, requestKey: 'c1' };
      for (let attempt = 0; attempt < 2; attempt++) {
        const error = await refusal(samScheduleCancel.run(keyed('c1'), input));
        expect(error.code).toBe('invalid_input');
        expect(error.message).toContain('sam_schedule_update');
      }
      expect(receipts()).toEqual([]);
      expect(triggerRow('trig-p')?.status).toBe('active');
      const missing = await refusal(
        samScheduleCancel.run(ctx(), {
          projectId: 'p',
          scheduleId: 'trig-other',
          expectedVersion: 1,
        })
      );
      expect(missing.code).toBe('not_found');
    });
  });

  it('exports the five operations with stable names and kinds', () => {
    // A read-only Connector connection lists only `read` operations, and apps confirm
    // `destructive` ones with the user, so each kind is part of the contract.
    expect(scheduleOperations.map((operation) => [operation.name, operation.kind])).toEqual([
      ['sam_schedules_list', 'read'],
      ['sam_schedule_get', 'read'],
      ['sam_schedule_create', 'write'],
      ['sam_schedule_update', 'write'],
      ['sam_schedule_cancel', 'destructive'],
    ]);
  });

  it('declares inputs every adapter can publish, and which creates start work', () => {
    for (const operation of scheduleOperations) {
      expect(() => operationInputJsonSchema(operation)).not.toThrow();
    }
    expect(scheduleCreateStartsWork({ cron: '0 9 * * *', action: { kind: 'start_session' } })).toBe(
      true
    );
    expect(scheduleCreateStartsWork({ runAt: 'x', action: { kind: 'start_session' } })).toBe(true);
    expect(scheduleCreateStartsWork({ runAt: 'x', action: { kind: 'message_session' } })).toBe(
      false
    );
    expect(scheduleCreateStartsWork({ runAt: 'x' })).toBe(false);
  });
});
