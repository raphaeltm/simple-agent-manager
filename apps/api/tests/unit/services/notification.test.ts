import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  sendNotification,
  notifyTaskComplete,
  notifyTaskFailed,
  notifySessionEnded,
  notifyPrCreated,
} from '../../../src/services/notification';

function createMockEnv() {
  const createNotificationMock = vi.fn().mockResolvedValue({
    id: 'test-id',
    type: 'task_complete',
    title: 'Test',
    createdAt: new Date().toISOString(),
  });

  const mockStub = {
    createNotification: createNotificationMock,
  };

  return {
    env: {
      NOTIFICATION: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => mockStub),
      },
    } as any,
    createNotificationMock,
  };
}

describe('Notification Service', () => {
  let env: any;
  let createNotificationMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = createMockEnv();
    env = mock.env;
    createNotificationMock = mock.createNotificationMock;
  });

  describe('sendNotification', () => {
    it('should resolve the correct DO by userId', async () => {
      await sendNotification(env, 'user-123', {
        type: 'task_complete',
        urgency: 'medium',
        title: 'Test notification',
      });

      expect(env.NOTIFICATION.idFromName).toHaveBeenCalledWith('user-123');
      expect(env.NOTIFICATION.get).toHaveBeenCalled();
      expect(createNotificationMock).toHaveBeenCalledWith('user-123', {
        type: 'task_complete',
        urgency: 'medium',
        title: 'Test notification',
      });
    });
  });

  describe('notifyTaskComplete', () => {
    it('should create a task_complete notification with PR URL', async () => {
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        taskId: 'task-1',
        taskTitle: 'Fix the bug',
        outputPrUrl: 'https://github.com/org/repo/pull/42',
        outputBranch: 'fix-bug',
      });

      expect(createNotificationMock).toHaveBeenCalledWith('user-123', expect.objectContaining({
        type: 'task_complete',
        urgency: 'medium',
        title: 'Task completed: Fix the bug',
        projectId: 'proj-1',
        taskId: 'task-1',
        actionUrl: '/projects/proj-1',
      }));

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.body).toContain('PR ready for review');
    });

    it('should create notification with branch fallback when no PR URL', async () => {
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        taskId: 'task-1',
        taskTitle: 'Add feature',
        outputBranch: 'sam/add-feature',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.body).toContain('Output on branch');
    });

    it('should truncate long task titles', async () => {
      const longTitle = 'A'.repeat(200);
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        taskId: 'task-1',
        taskTitle: longTitle,
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.title.length).toBeLessThanOrEqual(100);
    });
  });

  describe('notifyTaskFailed', () => {
    it('should create an error notification with high urgency', async () => {
      await notifyTaskFailed(env, 'user-123', {
        projectId: 'proj-1',
        taskId: 'task-1',
        taskTitle: 'Deploy to prod',
        errorMessage: 'Build failed: syntax error',
      });

      expect(createNotificationMock).toHaveBeenCalledWith('user-123', expect.objectContaining({
        type: 'error',
        urgency: 'high',
        title: 'Task failed: Deploy to prod',
        body: 'Build failed: syntax error',
      }));
    });

    it('should use default error message when none provided', async () => {
      await notifyTaskFailed(env, 'user-123', {
        projectId: 'proj-1',
        taskId: 'task-1',
        taskTitle: 'Test task',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.body).toBe('Task encountered an error');
    });
  });

  describe('notifySessionEnded', () => {
    it('should create session_ended notification with task title', async () => {
      await notifySessionEnded(env, 'user-123', {
        projectId: 'proj-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        taskTitle: 'Review code',
      });

      expect(createNotificationMock).toHaveBeenCalledWith('user-123', expect.objectContaining({
        type: 'session_ended',
        urgency: 'medium',
        title: 'Agent finished: Review code',
      }));
    });

    it('should use generic title when no task title', async () => {
      await notifySessionEnded(env, 'user-123', {
        projectId: 'proj-1',
        sessionId: 'session-1',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.title).toContain('your turn');
    });
  });

  describe('notifyPrCreated', () => {
    it('should create pr_created notification with metadata', async () => {
      await notifyPrCreated(env, 'user-123', {
        projectId: 'proj-1',
        taskId: 'task-1',
        taskTitle: 'Add tests',
        prUrl: 'https://github.com/org/repo/pull/99',
        branchName: 'sam/add-tests',
      });

      expect(createNotificationMock).toHaveBeenCalledWith('user-123', expect.objectContaining({
        type: 'pr_created',
        urgency: 'medium',
        title: 'PR created: Add tests',
        metadata: {
          prUrl: 'https://github.com/org/repo/pull/99',
          branchName: 'sam/add-tests',
        },
      }));
    });
  });
});
