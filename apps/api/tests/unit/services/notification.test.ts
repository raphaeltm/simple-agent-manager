import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MAX_NOTIFICATION_BODY_LENGTH } from '@simple-agent-manager/shared';
import {
  sendNotification,
  notifyTaskComplete,
  notifyTaskFailed,
  notifySessionEnded,
  notifyPrCreated,
  notifyNeedsInput,
  notifyProgress,
  getProjectName,
  buildActionUrl,
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
      DATABASE: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn().mockResolvedValue({ name: 'Test Project' }),
          })),
        })),
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

  describe('getProjectName', () => {
    it('should return the project name from D1 and bind the correct projectId', async () => {
      const firstMock = vi.fn().mockResolvedValue({ name: 'Test Project' });
      const bindMock = vi.fn(() => ({ first: firstMock }));
      env.DATABASE.prepare = vi.fn(() => ({ bind: bindMock }));

      const name = await getProjectName(env, 'proj-42');
      expect(name).toBe('Test Project');
      expect(env.DATABASE.prepare).toHaveBeenCalledWith('SELECT name FROM projects WHERE id = ?');
      expect(bindMock).toHaveBeenCalledWith('proj-42');
    });

    it('should return the projectId as fallback when project is not found', async () => {
      env.DATABASE.prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(null),
        })),
      }));
      const name = await getProjectName(env, 'unknown-proj');
      expect(name).toBe('unknown-proj');
    });

    it('should return the projectId as fallback when D1 query fails', async () => {
      env.DATABASE.prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockRejectedValue(new Error('D1 error')),
        })),
      }));
      const name = await getProjectName(env, 'error-proj');
      expect(name).toBe('error-proj');
    });
  });

  describe('notifyTaskComplete', () => {
    it('should create a task_complete notification with PR URL', async () => {
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
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

    it('should include projectName in metadata', async () => {
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Fix the bug',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.metadata.projectName).toBe('My Project');
    });

    it('should create notification with branch fallback when no PR URL', async () => {
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Add feature',
        outputBranch: 'sam/add-feature',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.body).toContain('Output on branch');
    });

    it('should use generic body when neither PR URL nor branch provided', async () => {
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Clean up code',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.body).toBe('Task finished successfully');
    });

    it('should truncate long task titles', async () => {
      const longTitle = 'A'.repeat(200);
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
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
        projectName: 'My Project',
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

    it('should include projectName in metadata', async () => {
      await notifyTaskFailed(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Deploy to prod',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.metadata.projectName).toBe('My Project');
    });

    it('should use default error message when none provided', async () => {
      await notifyTaskFailed(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
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
        projectName: 'My Project',
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

    it('should include projectName in metadata', async () => {
      await notifySessionEnded(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        sessionId: 'session-1',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.metadata.projectName).toBe('My Project');
    });

    it('should use generic title when no task title', async () => {
      await notifySessionEnded(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        sessionId: 'session-1',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.title).toContain('your turn');
    });
  });

  describe('notifyPrCreated', () => {
    it('should create pr_created notification with metadata including projectName', async () => {
      await notifyPrCreated(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
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
          projectName: 'My Project',
          prUrl: 'https://github.com/org/repo/pull/99',
          branchName: 'sam/add-tests',
        },
      }));
    });
  });

  describe('notifyNeedsInput', () => {
    it('should create needs_input notification with high urgency', async () => {
      await notifyNeedsInput(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Deploy to prod',
        context: 'I need approval to proceed with the database migration',
        category: 'approval',
        options: ['Approve', 'Reject', 'Defer'],
      });

      expect(createNotificationMock).toHaveBeenCalledWith('user-123', expect.objectContaining({
        type: 'needs_input',
        urgency: 'high',
        title: 'Approval needed: Deploy to prod',
        body: 'I need approval to proceed with the database migration',
        projectId: 'proj-1',
        taskId: 'task-1',
        actionUrl: '/projects/proj-1',
        metadata: {
          projectName: 'My Project',
          category: 'approval',
          options: ['Approve', 'Reject', 'Defer'],
        },
      }));
    });

    it('should use generic label when no category provided', async () => {
      await notifyNeedsInput(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Fix bug',
        context: 'I found multiple approaches, which do you prefer?',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.title).toContain('Input needed');
      expect(call.metadata.category).toBeNull();
      expect(call.metadata.options).toBeNull();
    });

    it('should truncate long context in body', async () => {
      const longContext = 'A'.repeat(1000);
      await notifyNeedsInput(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Task',
        context: longContext,
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.body!.length).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_LENGTH);
    });
  });

  describe('notifyProgress', () => {
    it('should create progress notification with low urgency', async () => {
      await notifyProgress(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Implement feature',
        message: 'Completed step 3 of 5: database schema migration',
      });

      expect(createNotificationMock).toHaveBeenCalledWith('user-123', expect.objectContaining({
        type: 'progress',
        urgency: 'low',
        title: 'Progress: Implement feature',
        body: 'Completed step 3 of 5: database schema migration',
        projectId: 'proj-1',
        taskId: 'task-1',
        actionUrl: '/projects/proj-1',
      }));
    });

    it('should include projectName in metadata', async () => {
      await notifyProgress(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Implement feature',
        message: 'Step done',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.metadata.projectName).toBe('My Project');
    });

    it('should truncate long messages in body', async () => {
      const longMessage = 'B'.repeat(1000);
      await notifyProgress(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Task',
        message: longMessage,
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.body!.length).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_LENGTH);
    });
  });

  describe('buildActionUrl', () => {
    it('should include sessionId in URL when provided', () => {
      expect(buildActionUrl('proj-1', 'session-42')).toBe('/projects/proj-1/chat/session-42');
    });

    it('should fall back to project URL when sessionId is null', () => {
      expect(buildActionUrl('proj-1', null)).toBe('/projects/proj-1');
    });

    it('should fall back to project URL when sessionId is undefined', () => {
      expect(buildActionUrl('proj-1', undefined)).toBe('/projects/proj-1');
    });

    it('should fall back to project URL when sessionId is empty string', () => {
      expect(buildActionUrl('proj-1', '')).toBe('/projects/proj-1');
    });
  });

  describe('actionUrl deep-links to chat session — regression guard', () => {
    it('notifyTaskComplete includes sessionId in actionUrl and payload', async () => {
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Fix bug',
        sessionId: 'sess-abc',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1/chat/sess-abc');
      expect(call.sessionId).toBe('sess-abc');
    });

    it('notifyTaskFailed includes sessionId in actionUrl and payload', async () => {
      await notifyTaskFailed(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Deploy',
        sessionId: 'sess-abc',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1/chat/sess-abc');
      expect(call.sessionId).toBe('sess-abc');
    });

    it('notifySessionEnded includes sessionId in actionUrl and payload', async () => {
      await notifySessionEnded(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        sessionId: 'sess-abc',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1/chat/sess-abc');
      expect(call.sessionId).toBe('sess-abc');
    });

    it('notifyNeedsInput includes sessionId in actionUrl and payload', async () => {
      await notifyNeedsInput(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Deploy',
        context: 'Need approval',
        sessionId: 'sess-abc',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1/chat/sess-abc');
      expect(call.sessionId).toBe('sess-abc');
    });

    it('notifyProgress includes sessionId in actionUrl and payload', async () => {
      await notifyProgress(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Feature',
        message: 'Step done',
        sessionId: 'sess-abc',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1/chat/sess-abc');
      expect(call.sessionId).toBe('sess-abc');
    });

    it('notifyTaskComplete falls back to project URL when sessionId absent', async () => {
      await notifyTaskComplete(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Fix bug',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1');
      expect(call.sessionId).toBeUndefined();
    });

    it('notifyTaskFailed falls back to project URL when sessionId absent', async () => {
      await notifyTaskFailed(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Deploy',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1');
      expect(call.sessionId).toBeUndefined();
    });

    it('notifySessionEnded falls back to project URL when sessionId absent', async () => {
      await notifySessionEnded(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1');
      expect(call.sessionId).toBeUndefined();
    });

    it('notifyNeedsInput falls back to project URL when sessionId absent', async () => {
      await notifyNeedsInput(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Deploy',
        context: 'Need approval',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1');
      expect(call.sessionId).toBeUndefined();
    });

    it('notifyProgress falls back to project URL when sessionId absent', async () => {
      await notifyProgress(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Feature',
        message: 'Step done',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1');
      expect(call.sessionId).toBeUndefined();
    });

    it('notifyPrCreated always uses project URL and has no sessionId', async () => {
      await notifyPrCreated(env, 'user-123', {
        projectId: 'proj-1',
        projectName: 'My Project',
        taskId: 'task-1',
        taskTitle: 'Add tests',
        prUrl: 'https://github.com/org/repo/pull/99',
      });

      const call = createNotificationMock.mock.calls[0]![1];
      expect(call.actionUrl).toBe('/projects/proj-1');
      expect(call.sessionId).toBeUndefined();
    });
  });

  describe('projectName in metadata — regression guard', () => {
    // MAINTENANCE: If you add a new notifyX helper to notification.ts,
    // you MUST add it to the array below. This guard ensures every helper
    // includes projectName in metadata so the frontend can display project names.
    it('every notification helper includes projectName in metadata', async () => {
      const helpers = [
        () => notifyTaskComplete(env, 'u', { projectId: 'p', projectName: 'PN', taskId: 't', taskTitle: 'T' }),
        () => notifyTaskFailed(env, 'u', { projectId: 'p', projectName: 'PN', taskId: 't', taskTitle: 'T' }),
        () => notifySessionEnded(env, 'u', { projectId: 'p', projectName: 'PN' }),
        () => notifyPrCreated(env, 'u', { projectId: 'p', projectName: 'PN', taskId: 't', taskTitle: 'T', prUrl: 'http://x' }),
        () => notifyNeedsInput(env, 'u', { projectId: 'p', projectName: 'PN', taskId: 't', taskTitle: 'T', context: 'c' }),
        () => notifyProgress(env, 'u', { projectId: 'p', projectName: 'PN', taskId: 't', taskTitle: 'T', message: 'm' }),
      ];

      for (const helper of helpers) {
        createNotificationMock.mockClear();
        await helper();
        const call = createNotificationMock.mock.calls[0]![1];
        expect(call.metadata).toBeDefined();
        expect(call.metadata.projectName).toBe('PN');
      }
    });
  });
});
