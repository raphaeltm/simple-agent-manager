/**
 * /sam dispatch_task records its `task.dispatched` activity event through the ProjectData
 * service. It used to POST to `https://do/activity`, which ProjectData.fetch never served (it
 * answers only `/ws`), so the event was silently dropped. That the same service call persists a
 * row is shown against the real Durable Object, for the MCP dispatch caller, in
 * tests/workers/mcp-task-activity-events.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildDispatchCtx,
  getDispatchTaskMocks,
  resetDispatchTaskMocks,
} from './sam-dispatch-test-helpers';

const { dispatchTask } =
  await import('../../../src/durable-objects/sam-session/tools/dispatch-task');

const dispatchTaskMocks = getDispatchTaskMocks();

interface DispatchResult {
  taskId?: string;
  sessionId?: string;
  branchName?: string;
  error?: string;
}

describe('SAM dispatch_task activity event', () => {
  beforeEach(() => {
    resetDispatchTaskMocks({ title: 'Child task title' });
  });

  it('records task.dispatched for the new task in its chat session', async () => {
    const { ctx } = buildDispatchCtx();

    const result = (await dispatchTask(
      { projectId: 'proj-1', description: 'Fix the flaky test' },
      ctx
    )) as DispatchResult;

    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe('session-1');
    expect(dispatchTaskMocks.recordActivityEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTaskMocks.recordActivityEvent).toHaveBeenCalledWith(
      ctx.env,
      'proj-1',
      'task.dispatched',
      'user',
      'user-1',
      null,
      'session-1',
      result.taskId,
      { title: 'Child task title', branchName: result.branchName, source: 'sam' }
    );
  });

  it('still dispatches when the activity event cannot be recorded', async () => {
    dispatchTaskMocks.recordActivityEvent.mockRejectedValueOnce(
      new Error('ProjectData unavailable')
    );
    const { ctx } = buildDispatchCtx();

    const result = (await dispatchTask(
      { projectId: 'proj-1', description: 'Fix the flaky test' },
      ctx
    )) as DispatchResult;

    expect(result.error).toBeUndefined();
    expect(result.taskId).toBeDefined();
    expect(dispatchTaskMocks.startTaskRunnerDO).toHaveBeenCalledTimes(1);
  });
});
