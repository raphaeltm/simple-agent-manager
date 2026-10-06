import { describe, expect, it } from 'vitest';

import {
  buildDeploymentEnvironmentLifecycleEventInput,
  buildDeploymentPublishJobLifecycleEventInput,
  buildDeploymentReleaseLifecycleEventInput,
  buildSessionLifecycleEventInput,
  buildTaskLifecycleEventInput,
  PROJECT_LIFECYCLE_EVENT_SOURCE,
} from '../../../src/services/project-lifecycle-event-inputs';

describe('project lifecycle event inputs', () => {
  it('builds stable task fingerprints across timestamp-only duplicate replays', async () => {
    const base = {
      projectId: 'project-1',
      taskId: 'task-1',
      status: 'completed' as const,
      fromStatus: 'in_progress',
      parentTaskId: 'parent-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      reason: 'done',
      source: 'test.task_terminal',
      title: 'Ship lifecycle producers',
    };

    const first = await buildTaskLifecycleEventInput({
      ...base,
      occurredAt: '2026-08-28T12:00:00.000Z',
    });
    const replay = await buildTaskLifecycleEventInput({
      ...base,
      occurredAt: '2026-08-28T12:01:00.000Z',
    });

    expect(first).toMatchObject({
      source: PROJECT_LIFECYCLE_EVENT_SOURCE,
      eventType: 'task.completed',
      subject: { type: 'task', id: 'task-1' },
      severity: 'info',
      deliveryKey: 'task:task-1:status:completed',
    });
    expect(first.rawPayloadRef).toBeUndefined();
    expect(first.payloadFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(replay.deliveryKey).toBe(first.deliveryKey);
    expect(replay.payloadFingerprint).toBe(first.payloadFingerprint);
    expect(replay.occurredAt).not.toBe(first.occurredAt);
  });

  it('bounds display and metadata fields before ProjectData admission', async () => {
    const event = await buildTaskLifecycleEventInput({
      projectId: 'project-1',
      taskId: 'task-1',
      status: 'failed',
      reason: 'x'.repeat(5000),
      source: 'test.failure',
      title: 'y'.repeat(5000),
    });

    expect(event.metadata?.reason).toMatch(/\.\.\.\[truncated\]$/);
    expect(String(event.metadata?.reason).length).toBeLessThan(5000);
    expect(event.display?.summary).toMatch(/\.\.\.\[truncated\]/);
    expect(event.rawPayloadRef).toBeUndefined();
  });

  it('builds normalized session and deployment lifecycle event types', async () => {
    await expect(
      buildSessionLifecycleEventInput({
        projectId: 'project-1',
        sessionId: 'session-1',
        lifecycle: 'woke',
        status: 'active',
        taskId: 'task-1',
        workspaceId: 'workspace-1',
        source: 'test.session_wake',
        occurredAt: '2026-08-28T12:00:00.000Z',
      })
    ).resolves.toMatchObject({
      eventType: 'session.woke',
      subject: { type: 'session', id: 'session-1' },
      metadata: { status: 'active', taskId: 'task-1', workspaceId: 'workspace-1' },
    });

    await expect(
      buildDeploymentReleaseLifecycleEventInput({
        projectId: 'project-1',
        releaseId: 'release-1',
        environmentId: 'env-1',
        status: 'applied',
        version: 3,
        source: 'test.release',
      })
    ).resolves.toMatchObject({
      eventType: 'deployment.release.applied',
      subject: { type: 'deployment_release', id: 'release-1' },
      metadata: { environmentId: 'env-1', status: 'applied', version: 3 },
    });

    await expect(
      buildDeploymentEnvironmentLifecycleEventInput({
        projectId: 'project-1',
        environmentId: 'env-1',
        lifecycle: 'observed',
        observedStatus: 'applied',
        observedAppliedSeq: 3,
        source: 'test.environment',
      })
    ).resolves.toMatchObject({
      eventType: 'deployment.environment.observed',
      deliveryKey: 'deployment_environment:env-1:observed:applied:3',
    });

    await expect(
      buildDeploymentPublishJobLifecycleEventInput({
        projectId: 'project-1',
        publishJobId: 'job-1',
        environmentId: 'env-1',
        status: 'FAILED',
        terminal: true,
        source: 'test.publish_job',
      })
    ).resolves.toMatchObject({
      eventType: 'deployment.publish_job.failed',
      severity: 'error',
      deliveryKey: 'deployment_publish_job:job-1:status:failed',
    });
  });
});
