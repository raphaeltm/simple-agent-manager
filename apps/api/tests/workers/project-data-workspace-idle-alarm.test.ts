/**
 * The real `ProjectData.alarm()` in workerd for a workspace whose active session has gone quiet:
 * the tick records the workspace's idle deadline and schedules the workspace idle section for it,
 * instead of re-arming that section at its minimum delay every minute until the timeout passes.
 * Sweep edge cases live in `tests/unit/conversation-idle-timeout.test.ts`; this proves the
 * production handler is wired to them.
 */
import {
  DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS,
  DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { PROJECT_DATA_ALARM_SCHEDULE_META_KEY } from '../../src/durable-objects/project-data/alarm-sections';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const QUIET_FOR_MS = 10 * 60_000;

describe('ProjectData workspace idle alarm', () => {
  it('schedules a quiet active workspace for its idle deadline, not the minimum re-arm delay', async () => {
    const projectId = `workspace-idle-alarm-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectDataTestDouble>;

    const result = await runInDurableObject(stub, async (instance, state) => {
      await instance.ensureProjectId(projectId);
      const sessionId = await instance.createSession(workspaceId, 'Quiet workspace');
      // The session last did anything ten minutes ago and is still active.
      const quietSince = Date.now() - QUIET_FOR_MS;
      state.storage.sql.exec(
        'UPDATE workspace_activity SET last_message_at = ?, created_at = ? WHERE workspace_id = ?',
        quietSince,
        quietSince,
        workspaceId
      );
      state.storage.sql.exec(
        'UPDATE chat_sessions SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?',
        quietSince,
        quietSince,
        quietSince,
        sessionId
      );

      await instance.alarm();

      const schedule = state.storage.sql
        .exec('SELECT value FROM do_meta WHERE key = ?', PROJECT_DATA_ALARM_SCHEDULE_META_KEY)
        .one().value;
      return {
        quietSince,
        tickedAt: Date.now(),
        nextIdleCheckAt: state.storage.sql
          .exec(
            'SELECT next_idle_check_at FROM workspace_activity WHERE workspace_id = ?',
            workspaceId
          )
          .one().next_idle_check_at,
        workspaceIdleDueAt: (JSON.parse(String(schedule)) as { pending: Record<string, number> })
          .pending.workspace_idle_timeouts,
        alarmAt: await state.storage.getAlarm(),
      };
    });

    const idleDeadline = result.quietSince + DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS;
    expect(result.nextIdleCheckAt).toBe(idleDeadline);
    expect(result.workspaceIdleDueAt).toBe(idleDeadline);
    expect(result.alarmAt).toBeGreaterThan(
      result.tickedAt + DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS
    );
  });
});
