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
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import {
  queueWorkspaceSessionSleep,
  sleepWorkspaceSession,
} from '../../src/services/session-sleep';
import { cancelScheduledSessionSleep } from '../../src/services/session-snapshot-sleep-cancel';
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
  let cancelOutcome: 'ok' | '404' | '409' | 'fail';

  beforeEach(() => {
    // The production shape: a turn re-reporting `prompting` with no end in sight.
    activity = { activity: 'prompting', activityAt: START.getTime() - 30_000 };
    fixture = createSessionSleepFixture('in_progress', () => activity);
    ({ sqlite, env, order } = fixture);
    cancelOutcome = 'ok';
    // `cancelAgentSessionOnNode`'s own contract: a status, never a throw.
    mocks.cancelAgentSession.mockImplementation(() => {
      order.push('cancel');
      if (cancelOutcome === '404') return Promise.resolve({ success: false, status: 404 });
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

    it.each(['404', '409'] as const)(
      'sleeps when the agent reports no turn in flight (%s)',
      async (outcome) => {
        cancelOutcome = outcome;
        await explicitSleep();
        expect(mocks.recordSessionTurnEnd).toHaveBeenCalled();
        expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
      }
    );

    it('is not aborted by the cancelled agent restarting (recovering) during capture', async () => {
      // `/cancel` restarts the killed agent idle, and it reports `recovering` while it does.
      mocks.recordSessionTurnEnd.mockImplementation(() => {
        order.push('turn-end');
        activity = { activity: 'recovering', activityAt: Date.now() };
        return Promise.resolve(true);
      });
      await explicitSleep();
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalled();
    });

    it('is aborted by a NEW prompt turn that starts during capture (control)', async () => {
      mocks.recordSessionTurnEnd.mockImplementation(() => {
        order.push('turn-end');
        activity = { activity: 'idle', activityAt: Date.now() };
        return Promise.resolve(true);
      });
      // A follow-up is delivered to the restarted agent while the final snapshot is captured.
      const capture = mocks.hibernateAgentSessionOnNode.getMockImplementation()!;
      mocks.hibernateAgentSessionOnNode.mockImplementation((...args: unknown[]) => {
        activity = { activity: 'prompting', activityAt: Date.now() };
        return capture(...(args as Parameters<typeof capture>));
      });
      await expect(explicitSleep()).rejects.toThrow(/activity changed/);
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
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

    it('stays required when the sweep retries it, so a reachable agent is stopped then', async () => {
      cancelOutcome = 'fail';
      await expect(explicitSleep()).rejects.toThrow(/could not stop the agent turn/);
      const failed = sqlite
        .prepare(
          `SELECT sleep_after, sleep_episode_started_at, sleep_required_episode_started_at
           FROM session_snapshots WHERE chat_session_id = 'chat-1'`
        )
        .get() as Record<string, string>;
      expect(failed.sleep_required_episode_started_at).toBe(failed.sleep_episode_started_at);

      // The turn is still `prompting`; a normal sleep would defer it forever.
      cancelOutcome = 'ok';
      const sweep = await runSessionSleepSweep(env, new Date(failed.sleep_after));

      expect(sweep).toMatchObject({ claimed: 1, slept: 1 });
      expect(cancelCalls()).toHaveLength(2);
      expect(snapshotRow()).toMatchObject({ sleep_status: 'sleeping' });
    });

    it('is no longer required once a person follows up in the chat (control)', async () => {
      cancelOutcome = 'fail';
      await expect(explicitSleep()).rejects.toThrow(/could not stop the agent turn/);
      // A human follow-up ends the episode; the next sleep is an ordinary idle sleep.
      await cancelScheduledSessionSleep(drizzle(env.DATABASE, { schema }), 'chat-1');
      await queueWorkspaceSessionSleep(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'idle',
        sleepAfterMs: 0,
      });

      cancelOutcome = 'ok';
      const sweep = await runSessionSleepSweep(env, new Date(START.getTime() + HOUR));

      expect(sweep).toMatchObject({ claimed: 0, deferred: 1 });
      expect(cancelCalls()).toHaveLength(1);
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

    it('retries a close that failed, because a retired intent is never selected again', async () => {
      strand('deleted');
      mocks.stopSession.mockRejectedValueOnce(new Error('ProjectData unavailable'));
      const first = await runSessionSleepSweep(env, START);
      expect(first).toMatchObject({ retired: 0 });
      expect(fixture.sessionStatus).not.toBe('stopped');

      const second = await runSessionSleepSweep(env, new Date(START.getTime() + MINUTE));
      expect(second).toMatchObject({ retired: 1 });
      expect(mocks.stopSession).toHaveBeenCalledTimes(2);
      expect(fixture.sessionStatus).toBe('stopped');
    });

    it('stops retrying a close that keeps failing after the sleep-failure window', async () => {
      strand('deleted');
      mocks.stopSession.mockRejectedValue(new Error('ProjectData unavailable'));
      sqlite
        .prepare(`UPDATE session_snapshots SET updated_at = ? WHERE chat_session_id = 'chat-1'`)
        .run(START.toISOString());
      // Inside the window the intent waits for the close to succeed.
      expect(await runSessionSleepSweep(env, new Date(START.getTime() + MINUTE))).toMatchObject({
        retired: 0,
      });
      // Past it the intent is retired anyway, so it stops taking a sweep slot.
      const pastWindow = new Date(START.getTime() + 25 * HOUR);
      expect(await runSessionSleepSweep(env, pastWindow)).toMatchObject({ retired: 1 });
    });

    it('keeps the chat while a stopped sibling workspace can still be restarted (control)', async () => {
      strand('deleted');
      sqlite
        .prepare(
          `INSERT INTO workspaces (id, node_id, project_id, user_id, chat_session_id, status, updated_at)
           VALUES ('workspace-2', 'node-1', 'project-1', 'user-1', 'chat-1', 'stopped', ?)`
        )
        .run(START.toISOString());
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
