import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { SubmitTriggeredTaskInput } from '../../../src/services/trigger-submit';

const reservedMocks = vi.hoisted(() => ({
  submitReservedTask: vi.fn(),
  reservedIdentitiesForTriggerExecution: vi.fn((triggerExecutionId: string) => ({
    taskId: `task-${triggerExecutionId}`,
    chatSessionId: `chat-${triggerExecutionId}`,
    initialMessageId: `msg-${triggerExecutionId}`,
    initialStatusEventId: `status-${triggerExecutionId}`,
  })),
}));

vi.mock('../../../src/services/reserved-task-submission', () => reservedMocks);

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { submitTriggeredTask, TriggerTaskSubmissionPendingError } =
  await import('../../../src/services/trigger-submit');

const env = { DATABASE: {} } as Env;

const defaultInput: SubmitTriggeredTaskInput = {
  triggerId: 'trigger-1',
  triggerExecutionId: 'exec-1',
  projectId: 'project-1',
  userId: 'user-1',
  renderedPrompt: 'Review all PRs from today',
  triggeredBy: 'cron',
  agentProfileId: null,
  taskMode: 'task',
  skillId: null,
  vmSizeOverride: null,
  triggerName: 'Daily Review',
};

describe('submitTriggeredTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits trigger executions through the reserved task adapter', async () => {
    reservedMocks.submitReservedTask.mockResolvedValueOnce({
      outcome: 'admitted',
      taskId: 'task-exec-1',
      sessionId: 'chat-exec-1',
      branchName: 'sam/daily-review-exec-1',
      startState: 'started',
      reused: false,
    });

    await expect(submitTriggeredTask(env, defaultInput)).resolves.toEqual({
      taskId: 'task-exec-1',
      sessionId: 'chat-exec-1',
      branchName: 'sam/daily-review-exec-1',
    });

    expect(reservedMocks.reservedIdentitiesForTriggerExecution).toHaveBeenCalledWith('exec-1');
    expect(reservedMocks.submitReservedTask).toHaveBeenCalledWith(env, {
      identities: {
        taskId: 'task-exec-1',
        chatSessionId: 'chat-exec-1',
        initialMessageId: 'msg-exec-1',
        initialStatusEventId: 'status-exec-1',
      },
      projectId: 'project-1',
      userId: 'user-1',
      prompt: 'Review all PRs from today',
      branchNameSeed: 'Daily Review',
      agentProfileId: null,
      skillId: null,
      taskMode: 'task',
      vmSizeOverride: null,
      source: {
        kind: 'trigger',
        sourceId: 'trigger-1',
        sourceExecutionId: 'exec-1',
        triggeredBy: 'cron',
        displayName: 'Daily Review',
        repositoryAccessFlow: 'trigger-cron',
        initialStatusReason: 'Triggered by cron (trigger: trigger-1)',
        initialStatusActorType: 'system',
        initialStatusActorId: null,
        triggerId: 'trigger-1',
        triggerExecutionId: 'exec-1',
      },
    });
  });

  it('preserves skill/profile and conversation-mode inputs for the adapter', async () => {
    reservedMocks.submitReservedTask.mockResolvedValueOnce({
      outcome: 'admitted',
      taskId: 'task-exec-1',
      sessionId: 'chat-exec-1',
      branchName: 'sam/daily-review-exec-1',
      startState: 'already_started',
      reused: true,
    });

    await submitTriggeredTask(env, {
      ...defaultInput,
      agentProfileId: 'profile-1',
      skillId: 'skill-1',
      taskMode: 'conversation',
      vmSizeOverride: 'medium',
    });

    expect(reservedMocks.submitReservedTask).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        agentProfileId: 'profile-1',
        skillId: 'skill-1',
        taskMode: 'conversation',
        vmSizeOverride: 'medium',
      })
    );
  });

  it('maps pending adapter outcomes to TriggerTaskSubmissionPendingError', async () => {
    reservedMocks.submitReservedTask.mockResolvedValueOnce({
      outcome: 'pending',
      taskId: 'task-exec-1',
      sessionId: 'chat-exec-1',
      branchName: 'sam/daily-review-exec-1',
      pendingAt: 'task_runner_start',
      reason: 'TaskRunner start confirmation is unavailable',
      reused: true,
    });

    await expect(submitTriggeredTask(env, defaultInput)).rejects.toMatchObject({
      name: 'TriggerTaskSubmissionPendingError',
      submission: {
        taskId: 'task-exec-1',
        sessionId: 'chat-exec-1',
        branchName: 'sam/daily-review-exec-1',
      },
    });
    expect(TriggerTaskSubmissionPendingError).toBeDefined();
  });

  it('surfaces conflicting adapter outcomes without retrying internally', async () => {
    reservedMocks.submitReservedTask.mockResolvedValueOnce({
      outcome: 'conflict',
      taskId: 'task-exec-1',
      sessionId: 'chat-exec-1',
      branchName: 'sam/daily-review-exec-1',
      reason: 'intent_fingerprint_mismatch',
      message: 'Task identity is already reserved for a different submission intent',
    });

    await expect(submitTriggeredTask(env, defaultInput)).rejects.toThrow(
      'Task identity is already reserved for a different submission intent'
    );
    expect(reservedMocks.submitReservedTask).toHaveBeenCalledOnce();
  });

  it('surfaces terminal adapter outcomes without restarting the task', async () => {
    reservedMocks.submitReservedTask.mockResolvedValueOnce({
      outcome: 'terminal',
      taskId: 'task-exec-1',
      sessionId: 'chat-exec-1',
      branchName: 'sam/daily-review-exec-1',
      status: 'completed',
      reason: null,
      reused: true,
    });

    await expect(submitTriggeredTask(env, defaultInput)).rejects.toThrow(
      'Reserved trigger task task-exec-1 is already terminal: completed'
    );
    expect(reservedMocks.submitReservedTask).toHaveBeenCalledOnce();
  });
});
