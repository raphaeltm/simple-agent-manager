import { describe, expect, it, vi } from 'vitest';

const reconcileTaskWaits = vi.hoisted(() => vi.fn(async () => ({ checked: 1 })));

vi.mock('../../../src/services/project-data', () => ({ reconcileTaskWaits }));

import {
  createTaskWaitTerminalTransitionHook,
  runTaskTerminalTransitionHooks,
} from '../../../src/services/task-terminal-transition-hooks';

describe('task terminal transition hooks', () => {
  it('publishes the shared event to injected subscribers', async () => {
    const handle = vi.fn(async () => {});
    const event = {
      taskId: 'task-1',
      projectId: 'project-1',
      parentTaskId: 'parent-1',
      status: 'completed' as const,
      reason: 'done',
      occurredAt: '2026-08-09T00:00:00.000Z',
      source: 'test',
    };

    await runTaskTerminalTransitionHooks(event, [{ name: 'future-parent-wake', handle }]);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledWith(event);
    await expect(runTaskTerminalTransitionHooks(event)).resolves.toBeUndefined();
  });

  it('nudges ProjectData reconciliation for the terminal child', async () => {
    const event = {
      taskId: 'child-1',
      projectId: 'project-1',
      parentTaskId: 'parent-1',
      status: 'failed' as const,
      reason: 'boom',
      occurredAt: '2026-08-09T00:00:00.000Z',
      source: 'test',
    };

    await createTaskWaitTerminalTransitionHook({} as never).handle(event);

    expect(reconcileTaskWaits).toHaveBeenCalledWith({}, 'project-1', 'child-1');
  });
});
