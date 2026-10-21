/**
 * The web Automation page builds watch filters from @simple-agent-manager/shared's lifecycle
 * source and event types, not from this API's builders. If the two drift, those watches stop
 * matching without any error, so this pins what the API emits to what shared declares.
 */
import {
  PROJECT_LIFECYCLE_EVENT_SOURCE as SHARED_SOURCE,
  PROJECT_LIFECYCLE_EVENT_TYPES,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  buildDeploymentReleaseLifecycleEventInput,
  buildSessionLifecycleEventInput,
  buildTaskLifecycleEventInput,
  PROJECT_LIFECYCLE_EVENT_SOURCE,
} from '../../../src/services/project-lifecycle-event-inputs';

const occurredAt = '2026-10-20T12:00:00.000Z';

describe('lifecycle events match the identities shared with the web watch presets', () => {
  it('uses the shared source', () => {
    expect(PROJECT_LIFECYCLE_EVENT_SOURCE).toBe(SHARED_SOURCE);
  });

  it('emits the shared event types for failed tasks, failed chats and releases', async () => {
    const task = await buildTaskLifecycleEventInput({
      projectId: 'project-1',
      taskId: 'task-1',
      status: 'failed',
      source: 'test.contract',
      occurredAt,
    });
    expect(task).toMatchObject({
      source: SHARED_SOURCE,
      eventType: PROJECT_LIFECYCLE_EVENT_TYPES.taskFailed,
    });

    const chat = await buildSessionLifecycleEventInput({
      projectId: 'project-1',
      sessionId: 'session-1',
      lifecycle: 'failed',
      status: 'error',
      source: 'test.contract',
      occurredAt,
    });
    expect(chat).toMatchObject({
      source: SHARED_SOURCE,
      eventType: PROJECT_LIFECYCLE_EVENT_TYPES.sessionFailed,
    });

    const release = (status: 'failed' | 'applied') =>
      buildDeploymentReleaseLifecycleEventInput({
        projectId: 'project-1',
        releaseId: 'release-1',
        environmentId: 'env-1',
        status,
        source: 'test.contract',
        occurredAt,
      });
    await expect(release('failed')).resolves.toMatchObject({
      source: SHARED_SOURCE,
      eventType: PROJECT_LIFECYCLE_EVENT_TYPES.releaseFailed,
    });
    await expect(release('applied')).resolves.toMatchObject({
      eventType: PROJECT_LIFECYCLE_EVENT_TYPES.releaseApplied,
    });
  });
});
