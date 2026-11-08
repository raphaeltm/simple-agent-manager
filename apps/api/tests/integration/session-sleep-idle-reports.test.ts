/** Real activity writes → eligibility → scheduled sleep → VM teardown. */
import {
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS,
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import {
  getSessionState,
  upsertActivityState,
} from '../../src/durable-objects/project-data/session-state';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import { evaluateRunawayCostCeiling } from '../../src/scheduled/stuck-task-ceiling';
import { parseHarnessWorkConfig } from '../../src/services/session-idleness';
import { createSchemaTables } from '../helpers/sqlite-d1';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const {
  sleepBoundaryMocks: mocks,
  createSessionSleepFixture,
  SLEEP_START: START,
} = await vi.hoisted(() => import('../helpers/session-sleep-fixture'));
const MINUTE = 60_000;

describe('automatic sleep with repeated idle reports', () => {
  let fixture: ReturnType<typeof createSessionSleepFixture>;
  let stateDb: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    fixture = createSessionSleepFixture('in_progress', () => ({
      activity: 'idle',
      activityAt: START.getTime(),
    }));
    createSchemaTables(fixture.sqlite, [schema.nodeLifecycleDecisions]);
    stateDb = new Database(':memory:');
    sql = createSqlStorage(stateDb);
    runMigrations(sql);
    mocks.getSessionState.mockImplementation(() =>
      Promise.resolve(getSessionState(sql, 'agent-1'))
    );
    fixture.sqlite
      .prepare(
        "UPDATE tasks SET task_mode = 'conversation', chat_session_id = 'chat-1' WHERE id = 'task-1'"
      )
      .run();
    // Start and finish a real turn. Subsequent idle reports must preserve this work clock.
    upsertActivityState(sql, 'agent-1', { activity: 'prompting', now: START.getTime() - MINUTE });
    report(0);
    fixture.sqlite
      .prepare(
        "UPDATE session_snapshots SET sleep_status = 'scheduled', sleep_after = ?, workspace_id = 'workspace-1', runtime = 'vm' WHERE id = 'snapshot-1'"
      )
      .run(START.toISOString());
  });

  afterEach(() => {
    stateDb.close();
    fixture.dispose();
  });

  function report(minute: number, progressMinute?: number | null) {
    const now = START.getTime() + minute * MINUTE;
    vi.setSystemTime(now);
    upsertActivityState(sql, 'agent-1', {
      activity: 'idle',
      now,
      ...(progressMinute === undefined
        ? {}
        : {
            runtimeWorkState: 'active' as const,
            runtimeWorkCount: 1,
            runtimeWorkSource: 'claude_sdk',
            runtimeWorkProgressAt:
              progressMinute === null ? null : START.getTime() + progressMinute * MINUTE,
          }),
    });
  }

  async function sweep(minute: number) {
    const now = new Date(START.getTime() + minute * MINUTE);
    vi.setSystemTime(now);
    return runSessionSleepSweep(fixture.env, now);
  }

  function assertSlept() {
    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledOnce();
    expect(fixture.sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get()).toEqual({
      status: 'sleeping',
    });
  }

  it('sleeps after the work idle interval despite a report every 60 seconds', async () => {
    for (let minute = 1; minute <= 15; minute++) {
      report(minute);
      if (minute % 5 === 0) {
        const result = await sweep(minute);
        expect(result.slept).toBe(minute === 15 ? 1 : 0);
      }
    }
    expect(getSessionState(sql, 'agent-1')).toMatchObject({
      workAt: START.getTime(),
      activityAt: START.getTime() + 15 * MINUTE,
    });
    assertSlept();
    const decision = fixture.sqlite
      .prepare(
        "SELECT reason, detail_json FROM node_lifecycle_decisions WHERE source = 'session_sleep'"
      )
      .get() as { reason: string; detail_json: string };
    expect(decision.reason).toBe('idle');
    expect(JSON.parse(decision.detail_json)).toMatchObject({
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-1',
      activity: 'idle',
      workAt: START.getTime(),
    });
  });

  it.each([undefined, '1800000'])(
    'keeps recent background progress awake until the resolved bound (%s), then sleeps',
    async (override) => {
      if (override) fixture.env.HARNESS_BACKGROUND_WORK_MAX_DURATION_MS = override;
      const config = parseHarnessWorkConfig(fixture.env);
      expect(config.maxDurationMs).toBe(override ? 30 * MINUTE : 120 * MINUTE);
      // Genuine progress at minute 10 renews the bound; heartbeat reports do not.
      const endMinute = 10 + config.maxDurationMs / MINUTE;
      for (let minute = 1; minute <= endMinute; minute++) {
        report(minute, minute < 10 ? 0 : 10);
        if (minute % 5 === 0) {
          const result = await sweep(minute);
          expect(result.slept).toBe(minute === endMinute ? 1 : 0);
          if (minute < endMinute) expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
        }
      }
      assertSlept();
    }
  );

  it('bounds legacy background reports that omit a progress timestamp', async () => {
    report(0, null);
    for (let minute = 1; minute <= 120; minute++) {
      report(minute, null);
      if (minute % 5 === 0) {
        expect((await sweep(minute)).slept).toBe(minute === 120 ? 1 : 0);
      }
    }
    assertSlept();
  });

  it('renews background protection on a new real turn, independently of harness progress', async () => {
    report(0, 0);
    // A new foreground turn is real work even if its dev server has no new lifecycle edge.
    upsertActivityState(sql, 'agent-1', {
      activity: 'prompting',
      now: START.getTime() + 60 * MINUTE,
    });
    report(60, 0);
    for (let minute = 61; minute <= 180; minute++) {
      report(minute, 0);
      if (minute % 5 === 0) expect((await sweep(minute)).slept).toBe(minute === 180 ? 1 : 0);
    }
    assertSlept();
  });

  it.each(['chat-1', null])(
    'preserves a conversation at the absolute ceiling (task chat link %s) by queueing and completing sleep',
    async (taskChatId) => {
      const generationStart = START.getTime() - DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS - 30 * MINUTE;
      fixture.sqlite
        .prepare("UPDATE workspaces SET created_at = ? WHERE id = 'workspace-1'")
        .run(new Date(generationStart).toISOString());
      fixture.sqlite
        .prepare("UPDATE session_snapshots SET sleep_status = NULL WHERE id = 'snapshot-1'")
        .run();
      const verdict = await evaluateRunawayCostCeiling(
        fixture.env,
        {
          id: 'task-1',
          project_id: 'project-1',
          workspace_id: 'workspace-1',
          chat_session_id: taskChatId,
          startedAtMs: generationStart,
          taskMode: 'conversation',
          userId: 'user-1',
        },
        {
          nowMs: START.getTime(),
          absoluteCeilingMs: DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS,
          sleepGraceMs: DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS,
        }
      );
      expect(verdict).toEqual({ kind: 'preserve', reason: 'session_sleep_requested' });
      for (let minute = 1; minute <= 15; minute++) report(minute);
      expect(await sweep(15)).toMatchObject({ slept: 1 });
      assertSlept();
    }
  );

  it('keeps the cost backstop for task-mode work with a sleep-capable owner', async () => {
    const generationStart = START.getTime() - DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS - 30 * MINUTE;
    fixture.sqlite
      .prepare("UPDATE workspaces SET created_at = ? WHERE id = 'workspace-1'")
      .run(new Date(generationStart).toISOString());
    fixture.sqlite
      .prepare("UPDATE session_snapshots SET sleep_status = NULL WHERE id = 'snapshot-1'")
      .run();
    expect(
      await evaluateRunawayCostCeiling(
        fixture.env,
        {
          id: 'task-1',
          project_id: 'project-1',
          workspace_id: 'workspace-1',
          chat_session_id: 'chat-1',
          startedAtMs: generationStart,
          taskMode: 'task',
          userId: 'user-1',
        },
        {
          nowMs: START.getTime(),
          absoluteCeilingMs: DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS,
          sleepGraceMs: DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS,
        }
      )
    ).toMatchObject({ kind: 'terminalize', superseded: false });
  });

  it('does not renew the ceiling grace when queued sleep never completes', async () => {
    const generationStart = START.getTime() - DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS - 30 * MINUTE;
    fixture.sqlite
      .prepare("UPDATE workspaces SET created_at = ? WHERE id = 'workspace-1'")
      .run(new Date(generationStart).toISOString());
    fixture.sqlite
      .prepare("UPDATE session_snapshots SET sleep_status = NULL WHERE id = 'snapshot-1'")
      .run();
    const task = {
      id: 'task-1',
      project_id: 'project-1',
      workspace_id: 'workspace-1',
      chat_session_id: 'chat-1',
      startedAtMs: generationStart,
      taskMode: 'conversation',
      userId: 'user-1',
    };
    const bounds = {
      absoluteCeilingMs: DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS,
      sleepGraceMs: DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS,
    };
    expect(
      await evaluateRunawayCostCeiling(fixture.env, task, { ...bounds, nowMs: START.getTime() })
    ).toMatchObject({ kind: 'preserve' });
    // Even a newly stamped retry cannot renew the generation's immutable grace.
    const end = START.getTime() + DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS;
    fixture.sqlite
      .prepare(
        "UPDATE session_snapshots SET updated_at = ?, sleep_claimed_at = ? WHERE id = 'snapshot-1'"
      )
      .run(new Date(end).toISOString(), new Date(end).toISOString());
    expect(
      await evaluateRunawayCostCeiling(fixture.env, task, { ...bounds, nowMs: end })
    ).toMatchObject({
      kind: 'terminalize',
      superseded: false,
      inFlightSleepGraceExpired: { sleepStatus: 'scheduled' },
    });
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
  });

  it('declines unattended sleep without an anchor', async () => {
    // A legacy/corrupt row with no usable clock cannot establish elapsed idleness.
    stateDb
      .prepare(
        "UPDATE session_state SET work_at = NULL, activity_at = 0, runtime_work_progress_at = NULL WHERE session_id = 'agent-1'"
      )
      .run();
    expect(await sweep(180)).toMatchObject({ slept: 0, deferred: 1 });
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(
      fixture.sqlite.prepare("SELECT status FROM workspaces WHERE id = 'workspace-1'").get()
    ).toEqual({ status: 'running' });
  });
});
