/**
 * A slept VM task is woken by its own scheduled message and by an event it subscribed to.
 * Each case starts awake, sleeps through the real VM teardown (D1) and the real ProjectData
 * session transition, then fires through the production schedule or event-wake code and the
 * durable prompt-delivery alarm into the real VM delivery adapter. Only the wake itself
 * (`ensureSessionRecovery`) is a boundary: delivery must ask it to wake this chat with the
 * authority the wake carries. `eviction-recovery-prompt.test.ts` runs the real wake from a
 * queued-message delivery down to the TaskRunner start it requests.
 */
import {
  type DurabilityFoundationHooks,
  finalizeAcceptedPromptDelivery,
  processPromptDeliveryAlarm,
} from '@simple-agent-manager/project-data/internal/do/durability-foundation';
import {
  OWNER_ONLY_SCHEDULE,
  requireScheduleAction,
  SCHEDULE_CREATOR_AUTHORITY_ENDED,
  SCHEDULE_TARGET_OR_CREATOR_ENDED,
  SCHEDULE_TARGET_TASK_ENDED,
} from '@simple-agent-manager/project-data/internal/do/project-event-schedules-authority';
import { runScheduleAlarm } from '@simple-agent-manager/project-data/internal/do/project-event-schedules-runner';
import {
  createSchedule,
  getSchedule,
} from '@simple-agent-manager/project-data/internal/do/project-event-schedules-storage';
import {
  admitProjectEvent,
  createProjectEventSubscription,
} from '@simple-agent-manager/project-data/internal/do/project-events';
import {
  runProjectEventWakeMaterializationBatch,
  selectProjectEventWakeMaterializationCandidates,
} from '@simple-agent-manager/project-data/internal/do/project-events-materialization';
import { stopSession } from '@simple-agent-manager/project-data/internal/do/sessions';
import type { ProjectScheduledAction } from '@simple-agent-manager/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { isSessionRecoverySourceTaskGuardValid } from '../../src/services/session-recovery-authority';
import { sleepWorkspaceSession } from '../../src/services/session-sleep';
import { createSleepProjectDataFixture } from '../helpers/session-sleep-project-data-fixture';
import { createSchemaTables } from '../helpers/sqlite-d1';

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
  let assertSleeping: () => void;

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
    ({ doDb, sql, hooks, deliveries, assertSleeping } = createSleepProjectDataFixture(d1, mocks, {
      projectId: PROJECT,
      userId: USER,
      chatId: CHAT,
      taskId: TASK,
      startedAt: START,
    }));
    recovery.ensure.mockResolvedValue({ status: 'waking', taskId: TASK });
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
    assertSleeping();
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
    /** The production shape by default: an agent's reminder into its own chat. */
    async function scheduleWhileAwake(promptAuthor: 'agent' | 'human' = 'agent') {
      await requireScheduleAction(sql, env as never, PROJECT, USER, selfWake, OWNER_ONLY_SCHEDULE);
      return hooks.transactionSync(() =>
        createSchedule(
          sql,
          env as never,
          PROJECT,
          { userId: USER, chatSessionId: CHAT, promptAuthor },
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
      expect(recovery.ensure).toHaveBeenCalledWith(
        env,
        PROJECT,
        CHAT,
        {
          taskId: TASK,
          projectId: PROJECT,
          chatSessionId: CHAT,
          requiredProjectMemberId: USER,
        },
        { isDeliveryStillAuthorized: expect.any(Function) }
      );
      // A wake in progress keeps the message queued for retry rather than failing it.
      expect(inbox('scheduled_action')).toEqual([
        { target: CHAT, sourceTask: TASK, state: 'retry_wait' },
      ]);
    });

    it('accepts a new self-wake schedule created after the task already slept', async () => {
      await sleepTheTask();

      await expect(
        requireScheduleAction(sql, env as never, PROJECT, USER, selfWake, OWNER_ONLY_SCHEDULE)
      ).resolves.toMatchObject({
        targetTaskId: TASK,
        writer: { role: 'owner', ownerUserId: USER },
      });
    });

    function finishedAt(scheduleId: string) {
      return doDb
        .prepare('SELECT execution_finished_at AS finishedAt FROM project_schedules WHERE id = ?')
        .get(scheduleId) as { finishedAt: number | null };
    }

    // The chat ending first is a normal end: nothing is left to wake and no one can fix it, so
    // it is recorded like a cancellation rather than as a failure that asks for attention.
    it.each([
      [
        'the task completed',
        () => d1.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(TASK),
      ],
      [
        'the task was cancelled',
        () => d1.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(TASK),
      ],
      [
        'the task failed',
        () => d1.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(TASK),
      ],
    ])('records the self-wake as cancelled when %s before it was due', async (_label, change) => {
      const schedule = await scheduleWhileAwake();
      await sleepTheTask();
      change();

      await fireSchedule();

      expect(getSchedule(sql, PROJECT, schedule.id)).toMatchObject({
        state: 'cancelled',
        lastError: SCHEDULE_TARGET_TASK_ENDED,
        nextAttemptAt: null,
      });
      expect(finishedAt(schedule.id).finishedAt).toBe(START.getTime() + 11 * MINUTE);
      expect(inbox('scheduled_action')).toEqual([]);
      await runDeliveryAlarm();
      expect(recovery.ensure).not.toHaveBeenCalled();
    });

    it('records the self-wake as cancelled when the chat itself stopped before it was due', async () => {
      const schedule = await scheduleWhileAwake();
      await sleepTheTask();
      expect(stopSession(sql, CHAT)).not.toBeNull();

      await fireSchedule();

      expect(getSchedule(sql, PROJECT, schedule.id)).toMatchObject({
        state: 'cancelled',
        lastError: 'Scheduled target session is no longer active or recoverable',
      });
      expect(inbox('scheduled_action')).toEqual([]);
    });

    it("still records a failure a person can see when a person's schedule finds the chat ended", async () => {
      const schedule = await scheduleWhileAwake('human');
      await sleepTheTask();
      d1.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(TASK);

      await fireSchedule();

      expect(getSchedule(sql, PROJECT, schedule.id)).toMatchObject({
        state: 'failed',
        lastError: SCHEDULE_TARGET_TASK_ENDED,
      });
      expect(finishedAt(schedule.id).finishedAt).toBeNull();
      expect(inbox('scheduled_action')).toEqual([]);
    });

    // Without positive evidence the chat ended, the refusal stays a failure (rule 74).
    it.each([
      [
        'the task row is gone',
        () => d1.prepare('DELETE FROM tasks WHERE id = ?').run(TASK),
        SCHEDULE_TARGET_OR_CREATOR_ENDED,
      ],
      [
        'the task no longer points at this chat',
        () => d1.prepare('UPDATE tasks SET chat_session_id = NULL WHERE id = ?').run(TASK),
        SCHEDULE_TARGET_OR_CREATOR_ENDED,
      ],
      [
        'the task went back to draft',
        () => d1.prepare("UPDATE tasks SET status = 'draft' WHERE id = ?").run(TASK),
        SCHEDULE_TARGET_OR_CREATOR_ENDED,
      ],
      [
        'the chat has no task',
        () => doDb.prepare('UPDATE chat_sessions SET task_id = NULL WHERE id = ?').run(CHAT),
        'Scheduled target session is no longer active or recoverable',
      ],
    ])('still records a failure when %s', async (_label, change, lastError) => {
      const schedule = await scheduleWhileAwake();
      await sleepTheTask();
      change();

      await fireSchedule();

      expect(getSchedule(sql, PROJECT, schedule.id)).toMatchObject({ state: 'failed', lastError });
      expect(finishedAt(schedule.id).finishedAt).toBeNull();
      expect(inbox('scheduled_action')).toEqual([]);
    });

    it('still records a failure when the creator lost access while the chat is live', async () => {
      const schedule = await scheduleWhileAwake();
      await sleepTheTask();
      d1.prepare("UPDATE project_members SET status = 'suspended'").run();

      await fireSchedule();

      expect(getSchedule(sql, PROJECT, schedule.id)).toMatchObject({
        state: 'failed',
        lastError: SCHEDULE_CREATOR_AUTHORITY_ENDED,
      });
      expect(finishedAt(schedule.id).finishedAt).toBeNull();
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
      expect(recovery.ensure).toHaveBeenCalledWith(
        env,
        PROJECT,
        CHAT,
        {
          taskId: TASK,
          projectId: PROJECT,
          chatSessionId: CHAT,
          projectEventWake: { batchId: expect.any(String), subscriptionId: subscription.id },
        },
        { isDeliveryStillAuthorized: expect.any(Function) }
      );
      expect(inbox('project_event_wake')).toEqual([
        { target: CHAT, sourceTask: TASK, state: 'retry_wait' },
      ]);
    });
  });
});
