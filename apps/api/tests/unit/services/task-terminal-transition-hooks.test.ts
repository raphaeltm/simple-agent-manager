import { beforeEach, describe, expect, it, vi } from 'vitest';

const { admitProjectEventSourceIntentById, reconcileTaskWaits, recordTaskLifecycleEventViaSourceOutbox } = vi.hoisted(() => ({
  admitProjectEventSourceIntentById: vi.fn(async () => ({ state: 'admitted' })),
  reconcileTaskWaits: vi.fn(async () => ({ checked: 1 })),
  recordTaskLifecycleEventViaSourceOutbox: vi.fn(async () => ({ state: 'admitted' })),
}));

vi.mock('../../../src/services/project-lifecycle-events', () => ({ recordTaskLifecycleEventViaSourceOutbox }));

vi.mock('../../../src/services/project-data', () => ({ reconcileTaskWaits }));
vi.mock('../../../src/services/project-event-source-outbox', () => ({
  admitProjectEventSourceIntentById,
}));

import {
  createProjectEventTaskTerminalTransitionHook,
  createTaskWaitTerminalTransitionHook,
  runTaskTerminalTransitionHooks,
} from '../../../src/services/task-terminal-transition-hooks';

describe('task terminal transition hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('nudges the captured ProjectData task lifecycle intent for terminal tasks', async () => {
    const event = {
      taskId: 'child-1',
      projectId: 'project-1',
      parentTaskId: 'parent-1',
      projectEventSourceIntentId: 'intent-1',
      status: 'completed' as const,
      reason: 'done',
      occurredAt: '2026-08-09T00:00:00.000Z',
      source: 'test',
    };
    const env = { PROJECT_DATA: {} };

    await createProjectEventTaskTerminalTransitionHook(env as never).handle(event);

    expect(admitProjectEventSourceIntentById).toHaveBeenCalledWith(env, 'intent-1');
  });

  it('captures only explicitly opted-in legacy terminal writers and never rebuilds captured intents', async () => {
    const event = { taskId: 'task-1', projectId: 'project-1', parentTaskId: null,
      status: 'failed' as const, reason: 'Failed task', occurredAt: '2026-09-07T00:00:00Z', source: 'task_runner.fail_task' };
    const hook = createProjectEventTaskTerminalTransitionHook({} as never, { captureAtHook: true });
    await hook.handle(event);
    expect(recordTaskLifecycleEventViaSourceOutbox).toHaveBeenCalledExactlyOnceWith({}, event);
    await hook.handle({ ...event, projectEventSourceIntentId: 'captured' });
    expect(recordTaskLifecycleEventViaSourceOutbox).toHaveBeenCalledTimes(1);
    expect(admitProjectEventSourceIntentById).toHaveBeenCalledWith({}, 'captured');
  });

  it('does not rebuild a lifecycle event when the captured intent id is missing', async () => {
    const event = {
      taskId: 'child-1',
      projectId: 'project-1',
      parentTaskId: 'parent-1',
      status: 'completed' as const,
      reason: 'done',
      occurredAt: '2026-08-09T00:00:00.000Z',
      source: 'test',
    };

    await createProjectEventTaskTerminalTransitionHook({} as never).handle(event);

    expect(admitProjectEventSourceIntentById).not.toHaveBeenCalled();
    expect(recordTaskLifecycleEventViaSourceOutbox).not.toHaveBeenCalled();
  });
});
