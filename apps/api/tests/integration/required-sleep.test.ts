/**
 * A required sleep must not fail (policy a3780107, 2026-11-03).
 *
 * Production: chat ba36fd60-6b16-4001-a019-173cb8b2e9aa's turn hung `prompting` for hours. Every
 * sleep, including the one queued when its node reached its absolute lifetime, deferred with
 * "agent is not idle" until a person deleted the node, which stranded the chat.
 *
 * Driven through the real sleep service, sweep and SQL. Only the VM boundary is mocked:
 * `cancelAgentSessionOnNode`, the snapshot capture and the workspace stop.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import { queueWorkspaceSessionSleep, sleepWorkspaceSession } from '../../src/services/session-sleep';
import type { SleepActivity } from '../helpers/session-sleep-fixture';

const {
  sleepBoundaryMocks: mocks,
  createSessionSleepFixture,
  SLEEP_START: START,
} = await vi.hoisted(() => import('../helpers/session-sleep-fixture'));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('required sleep', () => {
  let sqlite: Database.Database;
  let env: Env;
  let activity: SleepActivity;
  let fixture: ReturnType<typeof createSessionSleepFixture>;
  let order: string[];
  let cancelOutcome: 'ok' | '409' | 'fail';

  beforeEach(() => {
    // The production shape: a turn re-reporting `prompting` with no end in sight.
    activity = { activity: 'prompting', activityAt: START.getTime() - 30_000 };
    fixture = createSessionSleepFixture('in_progress', () => activity);
    ({ sqlite, env, order } = fixture);
    cancelOutcome = 'ok';
    // `cancelAgentSessionOnNode`'s own contract: a status, never a throw.
    mocks.cancelAgentSession.mockImplementation(() => {
      order.push('cancel');
      if (cancelOutcome === '409') return Promise.resolve({ success: false, status: 409 });
      if (cancelOutcome === 'fail') return Promise.resolve({ success: false, status: 502 });
      return Promise.resolve({ success: true, status: 200 });
    });
    // The control-plane turn end is what makes ProjectData report the turn as over.
    mocks.recordSessionTurnEnd.mockImplementation(() => {
      order.push('turn-end');
      activity = { activity: 'idle', activityAt: Date.now() };
      return Promise.resolve(true);
    });
  });

  afterEach(() => fixture.dispose());

  function snapshotRow() {
    return sqlite
      .prepare(
        `SELECT sleep_status, sleeping_at, sleep_episode_failures FROM session_snapshots
         WHERE chat_session_id = 'chat-1'`
      )
      .get() as Record<string, unknown>;
  }

  function cancelCalls() {
    return mocks.cancelAgentSession.mock.calls.filter(
      (call) => call[0] === 'node-1' && call[1] === 'workspace-1' && call[2] === 'agent-1'
    );
  }

  function ageNode(ageMs: number, nodeClass = 'managed') {
    sqlite
      .prepare("UPDATE nodes SET created_at = ?, node_class = ? WHERE id = 'node-1'")
      .run(new Date(START.getTime() - ageMs).toISOString(), nodeClass);
  }

  async function queueLifetimeSleep() {
    await queueWorkspaceSessionSleep(env, {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'absolute_node_lifetime',
      sleepAfterMs: 0,
    });
  }

  describe('a person pressing Sleep', () => {
    const explicitSleep = () =>
      sleepWorkspaceSession(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'explicit test sleep',
      });

    it('stops a turn that is still prompting, then sleeps the session', async () => {
      await explicitSleep();

      expect(cancelCalls()).toHaveLength(1);
      expect(mocks.recordSessionTurnEnd).toHaveBeenCalledWith(
        env,
        'project-1',
        'agent-1',
        expect.objectContaining({ reason: 'cancelled', observedAt: expect.any(Number) })
      );
      // The turn ends before the final snapshot is captured.
      expect(order.indexOf('cancel')).toBeLessThan(order.indexOf('final-snapshot:chat-1'));
      expect(order.indexOf('turn-end')).toBeLessThan(order.indexOf('final-snapshot:chat-1'));
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalled();
      // The chat stays wakeable.
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
      expect(snapshotRow().sleeping_at).toEqual(expect.any(String));
    });

    it('sleeps when the agent reports no turn in flight (409)', async () => {
      cancelOutcome = '409';
      await explicitSleep();
      expect(mocks.recordSessionTurnEnd).toHaveBeenCalled();
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
    });

    it('fails, and spends the attempt budget, when the agent cannot confirm the stop', async () => {
      cancelOutcome = 'fail';
      await expect(explicitSleep()).rejects.toThrow(/could not stop the agent turn/);
      expect(mocks.recordSessionTurnEnd).not.toHaveBeenCalled();
      expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
      expect(snapshotRow()).toMatchObject({ sleep_status: 'failed', sleep_episode_failures: 1 });
    });

    it('records the turn end without the agent once the attempt budget is spent', async () => {
      cancelOutcome = 'fail';
      sqlite
        .prepare(
          `UPDATE session_snapshots SET sleep_episode_failures = 3, sleep_episode_started_at = ?
           WHERE chat_session_id = 'chat-1'`
        )
        .run(new Date(START.getTime() - 20 * MINUTE).toISOString());
      await explicitSleep();
      expect(cancelCalls()).toHaveLength(1);
      expect(mocks.recordSessionTurnEnd).toHaveBeenCalled();
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
    });

    it('does not stop anything when the turn has already ended (control)', async () => {
      activity = { activity: 'idle', activityAt: START.getTime() - MINUTE };
      await explicitSleep();
      expect(cancelCalls()).toHaveLength(0);
      expect(mocks.recordSessionTurnEnd).not.toHaveBeenCalled();
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
    });
  });

  describe('a node past its absolute lifetime', () => {
    it('waits for a running turn inside the leeway, without stopping it', async () => {
      ageNode(24 * HOUR + 10 * MINUTE);
      await queueLifetimeSleep();

      const sweep = await runSessionSleepSweep(env, START);

      expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
      expect(cancelCalls()).toHaveLength(0);
      expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    });

    it('sleeps as soon as the turn ends, without the idle interval', async () => {
      ageNode(24 * HOUR + 10 * MINUTE);
      activity = { activity: 'idle', activityAt: START.getTime() - MINUTE };
      await queueLifetimeSleep();

      const sweep = await runSessionSleepSweep(env, START);

      expect(sweep).toMatchObject({ claimed: 1, slept: 1 });
      expect(cancelCalls()).toHaveLength(0);
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
    });

    it('stops a turn still running after the leeway and sleeps the session', async () => {
      ageNode(24 * HOUR + 31 * MINUTE);
      await queueLifetimeSleep();

      const sweep = await runSessionSleepSweep(env, START);

      expect(sweep).toMatchObject({ claimed: 1, slept: 1 });
      expect(cancelCalls()).toHaveLength(1);
      expect(mocks.recordSessionTurnEnd).toHaveBeenCalled();
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
    });

    it('tears down through the bounded fallback when the agent never confirms', async () => {
      ageNode(24 * HOUR + 31 * MINUTE);
      cancelOutcome = 'fail';
      await queueLifetimeSleep();
      sqlite
        .prepare(
          `UPDATE session_snapshots SET sleep_status = 'failed', sleep_episode_failures = 3,
                  sleep_episode_started_at = ?, sleep_after = ?
           WHERE chat_session_id = 'chat-1'`
        )
        .run(new Date(START.getTime() - 20 * MINUTE).toISOString(), START.toISOString());

      const sweep = await runSessionSleepSweep(env, START);

      expect(sweep).toMatchObject({ fallbacks: 1, slept: 1 });
      expect(mocks.recordSessionTurnEnd).toHaveBeenCalled();
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalled();
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
    });

    it('leaves a young node unchanged: a running turn defers and is not stopped (control)', async () => {
      ageNode(2 * HOUR);
      await queueLifetimeSleep();
      const sweep = await runSessionSleepSweep(env, START);
      expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
      expect(cancelCalls()).toHaveLength(0);
    });

    it('never forces a user-owned node, however old (control)', async () => {
      ageNode(48 * HOUR, 'user-owned');
      await queueLifetimeSleep();
      const sweep = await runSessionSleepSweep(env, START);
      expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
      expect(cancelCalls()).toHaveLength(0);
    });
  });

  describe('a workspace deleted while its sleep was pending', () => {
    function strand(workspaceStatus: string) {
      sqlite
        .prepare(`UPDATE workspaces SET status = ? WHERE id = 'workspace-1'`)
        .run(workspaceStatus);
      sqlite
        .prepare(
          `UPDATE session_snapshots
           SET workspace_id = 'workspace-1', node_id = 'node-1', agent_session_id = 'agent-1',
               runtime = 'vm', status = 'available', sleep_status = 'scheduled', sleep_after = ?
           WHERE chat_session_id = 'chat-1'`
        )
        .run(START.toISOString());
    }

    it('closes the chat instead of leaving it active with no wake path', async () => {
      strand('deleted');
      const sweep = await runSessionSleepSweep(env, START);
      expect(sweep).toMatchObject({ retired: 1 });
      expect(mocks.stopSession).toHaveBeenCalledWith(env, 'project-1', 'chat-1');
      expect(fixture.sessionStatus).toBe('stopped');
    });

    it('keeps the chat of a stopped workspace, which can still be restarted (control)', async () => {
      strand('stopped');
      const sweep = await runSessionSleepSweep(env, START);
      expect(sweep).toMatchObject({ retired: 1 });
      expect(mocks.stopSession).not.toHaveBeenCalled();
    });

    it('keeps the chat when another workspace already serves it (control)', async () => {
      strand('deleted');
      sqlite
        .prepare(
          `INSERT INTO workspaces (id, node_id, project_id, user_id, chat_session_id, status, updated_at)
           VALUES ('workspace-2', 'node-1', 'project-1', 'user-1', 'chat-1', 'running', ?)`
        )
        .run(START.toISOString());
      await runSessionSleepSweep(env, START);
      expect(mocks.stopSession).not.toHaveBeenCalled();
    });
  });
});
