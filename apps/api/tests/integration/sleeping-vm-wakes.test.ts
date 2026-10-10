/**
 * A slept VM task is woken by its own scheduled message and by an event it subscribed to.
 * Each case starts awake, sleeps through the real VM teardown (D1) and the real ProjectData
 * session transition, then fires through the production schedule or event-wake code and the
 * durable prompt-delivery alarm into the real VM delivery adapter. Only the wake itself
 * (`ensureSessionRecovery`) is a boundary: delivery must ask it to wake this chat with the
 * authority the wake carries. `eviction-recovery-prompt.test.ts` runs the real wake from a
 * queued-message delivery down to the TaskRunner start it requests.
 */
import type { ProjectScheduledAction } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import {
  type DurabilityFoundationHooks,
  finalizeAcceptedPromptDelivery,
  processPromptDeliveryAlarm,
} from '../../src/durable-objects/project-data/durability-foundation';
import { requireScheduleAction } from '../../src/durable-objects/project-data/project-event-schedules-authority';
import { runScheduleAlarm } from '../../src/durable-objects/project-data/project-event-schedules-runner';
import {
  createSchedule,
  getSchedule,
} from '../../src/durable-objects/project-data/project-event-schedules-storage';
import {
  admitProjectEvent,
  createProjectEventSubscription,
} from '../../src/durable-objects/project-data/project-events';
import {
  runProjectEventWakeMaterializationBatch,
  selectProjectEventWakeMaterializationCandidates,
} from '../../src/durable-objects/project-data/project-events-materialization';
import { sleepSession as sleepChatSession } from '../../src/durable-objects/project-data/sessions';
import type { Env } from '../../src/env';
import { isSessionRecoverySourceTaskGuardValid } from '../../src/services/session-recovery-authority';
import { sleepWorkspaceSession } from '../../src/services/session-sleep';
import { createSchemaTables } from '../helpers/sqlite-d1';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const recovery = vi.hoisted(() => ({ ensure: vi.fn(), report: vi.fn() }));
vi.mock('../../src/services/session-recovery', () => ({
  ensureSessionRecovery: recovery.ensure,
  reportSessionRecoveryRefusal: recovery.report,
}));

const {
  sleepBoundaryMocks: mocks,
  createSessionSleepFixture,
  SLEEP_START: START,
} = await vi.hoisted(() => import('../helpers/session-sleep-fixture'));

const PROJECT = 'project-1';
const USER = 'user-1';
const CHAT = 'chat-1';
const TASK = 'task-1';
const MINUTE = 60_000;
const selfWake: ProjectScheduledAction = {
  kind: 'message_session',
  sessionId: CHAT,
  prompt: 'Check whether CI finished, then continue the task.',
};

describe('a slept VM task is woken through the durable prompt queue', () => {
  let fixture: ReturnType<typeof createSessionSleepFixture>;
  let d1: Database.Database;
  let env: Env;
  let doDb: Database.Database;
  let sql: SqlStorage;
  let hooks: DurabilityFoundationHooks;
  let deliveries: Promise<unknown>[];

  beforeEach(() => {
    fixture = createSessionSleepFixture('in_progress', () => ({
      activity: 'idle',
      activityAt: START.getTime(),
    }));
    ({ sqlite: d1, env } = fixture);
    Object.assign(env, {
      DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
      PROJECT_EVENT_WAKE_ENABLED: 'true',
    });
    createSchemaTables(d1, [schema.users]);
    d1.prepare("INSERT INTO users (id, status) VALUES (?, 'active')").run(USER);
    d1.prepare(
      "INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'maintainer', 'active')"
    ).run(PROJECT, USER);
    d1.prepare('UPDATE projects SET user_id = ? WHERE id = ?').run(USER, PROJECT);
    // A VM task submission links its chat; the fixture's snapshot row predates the VM runtime.
    d1.prepare("UPDATE tasks SET chat_session_id = ?, task_mode = 'task' WHERE id = ?").run(
      CHAT,
      TASK
    );
    d1.prepare("UPDATE session_snapshots SET runtime = 'vm' WHERE chat_session_id = ?").run(CHAT);

    doDb = new Database(':memory:');
    sql = createSqlStorage(doDb);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions
        (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, 'workspace-1', ?, 'Task conversation', 'active', 1, ?, ?, ?)`,
      CHAT,
      TASK,
      START.getTime(),
      START.getTime(),
      START.getTime()
    );
    // The VM teardown reads and transitions the chat through the real ProjectData functions.
    mocks.getSession.mockImplementation((_env: Env, _projectId: string, sessionId: string) => {
      const row = doDb
        .prepare(
          'SELECT id, status, task_id AS taskId, workspace_id AS workspaceId FROM chat_sessions WHERE id = ?'
        )
        .get(sessionId);
      return Promise.resolve(row ?? null);
    });
    mocks.sleepSession.mockImplementation(
      (_env: Env, _projectId: string, sessionId: string, options?: object) =>
        Promise.resolve(sleepChatSession(sql, sessionId, options))
    );
    recovery.ensure.mockResolvedValue({ status: 'waking', taskId: TASK });

    deliveries = [];
    hooks = {
      getProjectId: () => PROJECT,
      transactionSync: <T>(fn: () => T): T => doDb.transaction(fn)(),
      waitUntil: (promise) => {
        deliveries.push(promise);
      },
      recalculateAlarm: vi.fn(async () => undefined),
      scheduleSummarySync: vi.fn(),
      broadcastEvent: vi.fn(),
      armIdleCleanup: vi.fn(),
      nudgeDeliveries: vi.fn(() => 0),
    };
  });

  afterEach(() => {
    doDb.close();
    fixture.dispose();
  });

  async function sleepTheTask() {
    await sleepWorkspaceSession(env, {
      workspaceId: 'workspace-1',
      userId: USER,
      reason: 'agent ended its turn and went idle',
    });
    expect(d1.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK)).toEqual({
      status: 'sleeping',
    });
    expect(d1.prepare('SELECT status FROM workspaces WHERE id = ?').get('workspace-1')).toEqual({
      status: 'sleeping',
    });
    expect(doDb.prepare('SELECT status FROM chat_sessions WHERE id = ?').get(CHAT)).toEqual({
      status: 'sleeping',
    });
  }

  async function runDeliveryAlarm() {
    processPromptDeliveryAlarm(sql, env as never, hooks);
    await Promise.all(deliveries.splice(0));
  }

  function inbox(sourceKind: string) {
    return doDb
      .prepare(
        `SELECT target_session_id AS target, source_task_id AS sourceTask, delivery_state AS state
           FROM session_inbox WHERE source_kind = ?`
      )
      .all(sourceKind);
  }

  describe('scheduled message_session self-wake', () => {
    async function scheduleWhileAwake() {
      await requireScheduleAction(sql, env as never, PROJECT, USER, selfWake);
      return hooks.transactionSync(() =>
        createSchedule(
          sql,
          env as never,
          PROJECT,
          { userId: USER, chatSessionId: CHAT },
          {
            action: selfWake,
            dueAt: Date.now() + 10 * MINUTE,
            displayTimezone: 'UTC',
            idempotencyKey: 'ci-check',
          },
          Date.now()
        )
      ).schedule;
    }

    async function fireSchedule() {
      vi.setSystemTime(new Date(START.getTime() + 11 * MINUTE));
      await runScheduleAlarm(sql, env as never, hooks);
    }

    it('admits the schedule, queues the scheduled message and asks to wake the slept chat', async () => {
      const schedule = await scheduleWhileAwake();
      await sleepTheTask();

      await fireSchedule();

      expect(getSchedule(sql, PROJECT, schedule.id)).toMatchObject({
        state: 'admitted',
        resultSessionId: CHAT,
        lastError: null,
      });
      expect(inbox('scheduled_action')).toEqual([
        { target: CHAT, sourceTask: TASK, state: 'queued' },
      ]);

      await runDeliveryAlarm();

      expect(recovery.ensure).toHaveBeenCalledOnce();
      expect(recovery.ensure).toHaveBeenCalledWith(env, PROJECT, CHAT, {
        taskId: TASK,
        projectId: PROJECT,
        chatSessionId: CHAT,
        requiredProjectMemberId: USER,
      });
      // A wake in progress keeps the message queued for retry rather than failing it.
      expect(inbox('scheduled_action')).toEqual([
        { target: CHAT, sourceTask: TASK, state: 'retry_wait' },
      ]);
    });

    it('accepts a new self-wake schedule created after the task already slept', async () => {
      await sleepTheTask();

      await expect(requireScheduleAction(sql, env as never, PROJECT, USER, selfWake)).resolves.toBe(
        TASK
      );
    });

    it.each([
      [
        'the task completed',
        () => d1.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(TASK),
      ],
      [
        'the creator was suspended',
        () => d1.prepare("UPDATE project_members SET status = 'suspended'").run(),
      ],
    ])('still refuses the self-wake when %s while it slept', async (_label, change) => {
      const schedule = await scheduleWhileAwake();
      await sleepTheTask();
      change();

      await fireSchedule();

      expect(getSchedule(sql, PROJECT, schedule.id)).toMatchObject({
        state: 'failed',
        lastError: 'Scheduled target or creator authority is no longer active',
      });
      expect(inbox('scheduled_action')).toEqual([]);
      await runDeliveryAlarm();
      expect(recovery.ensure).not.toHaveBeenCalled();
    });
  });

  describe('event subscription wake', () => {
    function subscribeToPullRequestWhileAwake() {
      return hooks.transactionSync(
        () =>
          createProjectEventSubscription(sql, env as never, PROJECT, {
            projectId: PROJECT,
            owner: { type: 'agent', id: `${PROJECT}:${CHAT}`, name: 'agent-1' },
            idempotencyKey: 'pr-42-reviews',
            filter: { version: 1, source: 'github', subjectType: 'pull_request', subjectId: '42' },
            deliveryPreference: {
              requested: 'existing_session_prompt',
              resolved: 'queued_for_prompt_delivery',
              target: { sessionId: CHAT, taskId: TASK, runtimeId: null, agentId: 'agent-1' },
            },
            ownerTaskId: TASK,
          }).subscription
      );
    }

    function pullRequestReviewed() {
      return hooks.transactionSync(() =>
        admitProjectEvent(sql, env as never, PROJECT, {
          projectId: PROJECT,
          source: 'github',
          eventType: 'pull_request_review.submitted',
          subject: { type: 'pull_request', id: '42' },
          deliveryKey: 'github-delivery-1',
          payloadFingerprint: 'sha256:github-delivery-1',
        })
      );
    }

    /**
     * The steps of the private `ProjectData.runProjectEventWakeMaterializationAlarm`, through the
     * real functions it calls. Its no-candidate, early-return and checkpoint branches do not
     * apply to this single-candidate run.
     */
    async function materializeWakes() {
      const candidates = hooks.transactionSync(() =>
        selectProjectEventWakeMaterializationCandidates(sql, env as never, PROJECT, Date.now())
      );
      for (const candidate of candidates) {
        expect(
          await isSessionRecoverySourceTaskGuardValid(env.DATABASE, candidate.sourceTaskGuard)
        ).toBe(true);
        const result = hooks.transactionSync(() =>
          runProjectEventWakeMaterializationBatch(sql, env as never, PROJECT, Date.now(), {
            subscriptionId: candidate.subscriptionId,
            ignoreSchedulerCheckpoint: true,
            recordGlobalCapacityDeferral: false,
          })
        );
        for (const item of result.accepted) {
          await finalizeAcceptedPromptDelivery(sql, env as never, hooks, item.input, item.accepted);
        }
      }
      return candidates;
    }

    it('delivers a pull request event to the slept chat and asks to wake it', async () => {
      const subscription = subscribeToPullRequestWhileAwake();
      await sleepTheTask();
      vi.setSystemTime(new Date(START.getTime() + 5 * MINUTE));
      expect(pullRequestReviewed().outcome).toBe('created');

      expect(await materializeWakes()).toHaveLength(1);
      expect(inbox('project_event_wake')).toEqual([
        { target: CHAT, sourceTask: TASK, state: 'queued' },
      ]);

      await runDeliveryAlarm();

      expect(recovery.ensure).toHaveBeenCalledOnce();
      expect(recovery.ensure).toHaveBeenCalledWith(env, PROJECT, CHAT, {
        taskId: TASK,
        projectId: PROJECT,
        chatSessionId: CHAT,
        projectEventWake: { batchId: expect.any(String), subscriptionId: subscription.id },
      });
      expect(inbox('project_event_wake')).toEqual([
        { target: CHAT, sourceTask: TASK, state: 'retry_wait' },
      ]);
    });
  });
});
