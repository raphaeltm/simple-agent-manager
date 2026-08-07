/**
 * TaskRunner DO instant-launch RPC contract (real DO storage via Miniflare).
 *
 * Verifies the durable-acceptance invariants:
 * - startInstantLaunch commits the job AND its wake-up alarm atomically
 * - duplicate accepts are idempotent and keep the alarm armed
 * - a task is EITHER a VM run or an instant launch, never both
 *
 * The launch execution itself (milestone classification, fail-closed
 * interruption handling) is covered by
 * tests/unit/durable-objects/task-runner-instant-launch.test.ts; here the
 * alarm is disarmed inside the same DO execution (input gates hold) so the
 * real continuation never runs against test bindings.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { TaskRunner } from '../../src/durable-objects/task-runner';
import {
  INSTANT_LAUNCH_STORAGE_KEY,
  type InstantLaunchJob,
} from '../../src/durable-objects/task-runner/instant-launch';
import type {
  AcceptedInstantSession,
  LaunchInstantSessionInput,
} from '../../src/services/instant-session';

function makeLaunchInput(taskId: string): LaunchInstantSessionInput {
  return {
    taskId,
    project: { id: 'project-il-test', repository: 'test/repo' } as never,
    userId: 'user-il-test',
    initialPrompt: 'hello',
    agentType: 'claude-code',
  };
}

function makeAccepted(taskId: string): AcceptedInstantSession {
  return {
    taskId,
    runtime: 'cf-container',
    nodeId: 'node-il-test',
    workspaceId: 'ws-il-test',
    projectId: 'project-il-test',
    chatSessionId: 'chat-il-test',
    agentType: 'claude-code',
    containerId: 'node-il-test',
    workspaceUrl: 'https://ws-ws-il-test.example.com',
    branch: 'main',
    workspaceName: 'instant chat',
    workspaceDir: '/workspaces/repo',
    nodeCallbackToken: 'callback-token',
    startedAt: Date.now(),
    gitSource: { repoProvider: 'github' } as never,
  };
}

function getStub(taskId: string): DurableObjectStub<TaskRunner> {
  return env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(taskId)) as DurableObjectStub<TaskRunner>;
}

describe('TaskRunner.startInstantLaunch', () => {
  it('commits the job and its alarm atomically', async () => {
    const taskId = 'task-il-accept';
    const stub = getStub(taskId);

    await runInDurableObject(stub, async (instance) => {
      await instance.startInstantLaunch(makeLaunchInput(taskId), makeAccepted(taskId));

      const job = await instance.ctx.storage.get<InstantLaunchJob>(INSTANT_LAUNCH_STORAGE_KEY);
      expect(job).toBeDefined();
      expect(job?.attempted).toBe(false);
      expect(job?.milestone).toBe('pending');
      expect(job?.accepted.workspaceId).toBe('ws-il-test');
      // A readable job must prove the wake-up was durably scheduled too.
      expect(await instance.ctx.storage.getAlarm()).not.toBeNull();

      // Disarm inside the same input-gated execution so the real launch
      // never runs against test bindings.
      await instance.ctx.storage.deleteAlarm();
      await instance.ctx.storage.deleteAll();
    });
  });

  it('is idempotent on duplicate accept and re-arms the wake-up', async () => {
    const taskId = 'task-il-duplicate';
    const stub = getStub(taskId);

    await runInDurableObject(stub, async (instance) => {
      await instance.startInstantLaunch(makeLaunchInput(taskId), makeAccepted(taskId));
      const first = await instance.ctx.storage.get<InstantLaunchJob>(INSTANT_LAUNCH_STORAGE_KEY);
      // Simulate a lost wake-up, then a route retry of the accept RPC.
      await instance.ctx.storage.deleteAlarm();
      await instance.startInstantLaunch(makeLaunchInput(taskId), makeAccepted(taskId));

      const second = await instance.ctx.storage.get<InstantLaunchJob>(INSTANT_LAUNCH_STORAGE_KEY);
      expect(second?.createdAt).toBe(first?.createdAt);
      expect(await instance.ctx.storage.getAlarm()).not.toBeNull();

      await instance.ctx.storage.deleteAlarm();
      await instance.ctx.storage.deleteAll();
    });
  });

  it('rejects VM orchestration for a task that already owns an instant launch, and vice versa', async () => {
    const taskId = 'task-il-exclusive';
    const stub = getStub(taskId);

    await runInDurableObject(stub, async (instance) => {
      await instance.startInstantLaunch(makeLaunchInput(taskId), makeAccepted(taskId));
      await expect(
        instance.start({
          taskId,
          projectId: 'project-il-test',
          userId: 'user-il-test',
          config: { taskMode: 'task' } as never,
        })
      ).rejects.toThrow('already owns an instant launch');

      await instance.ctx.storage.deleteAlarm();
      await instance.ctx.storage.deleteAll();

      // Opposite direction: existing VM state blocks an instant accept.
      await instance.ctx.storage.put('state', {
        version: 1,
        taskId,
        currentStep: 'node_selection',
        completed: false,
        stepResults: {},
        config: {},
      });
      await expect(
        instance.startInstantLaunch(makeLaunchInput(taskId), makeAccepted(taskId))
      ).rejects.toThrow('already owns VM orchestration');

      await instance.ctx.storage.deleteAlarm();
      await instance.ctx.storage.deleteAll();
    });
  });
});
