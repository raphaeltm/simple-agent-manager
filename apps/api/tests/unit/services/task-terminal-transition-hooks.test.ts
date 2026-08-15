import { describe, expect, it, vi } from 'vitest';

import { runTaskTerminalTransitionHooks } from '../../../src/services/task-terminal-transition-hooks';

describe('task terminal transition hooks', () => {
  it('publishes the shared event to injected subscribers without a built-in wake subscriber', async () => {
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
});
