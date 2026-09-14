import { describe, expect, it, vi } from 'vitest';

import { computeProjectEventMaterializationAlarmTime } from '../../../src/durable-objects/project-data/project-events-scheduler';
import { isProjectEventWakeEnabled } from '../../../src/durable-objects/project-data/project-events-wake-config';
import type { Env } from '../../../src/durable-objects/project-data/types';

// Drive the scheduler's real resolver: no feature-flag mocks or injected default.
describe('project event wake activation', () => {
  it.each([undefined, '', ' ', 'false', 'TRUE', 'invalid'])(
    'keeps materialization dormant with flag %j',
    (flag) => {
      const env = (flag === undefined ? {} : { PROJECT_EVENT_WAKE_ENABLED: flag }) as Env;
      const exec = vi.fn();
      const sql = { exec } as unknown as SqlStorage;

      expect(isProjectEventWakeEnabled(env)).toBe(false);
      expect(computeProjectEventMaterializationAlarmTime(sql, env, 'project', 100)).toBeNull();
      expect(exec).not.toHaveBeenCalled();
    }
  );

  it('schedules pending wake work after explicit activation', () => {
    const env = { PROJECT_EVENT_WAKE_ENABLED: 'true' } as Env;
    const exec = vi.fn().mockReturnValue({
      toArray: () => [{ next_attempt_at: 200, next_retention_at: null }],
    });
    const sql = { exec } as unknown as SqlStorage;

    expect(isProjectEventWakeEnabled(env)).toBe(true);
    expect(computeProjectEventMaterializationAlarmTime(sql, env, 'project', 100)).toBe(200);
    expect(exec).toHaveBeenCalledOnce();
  });
});
