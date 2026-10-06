import { describe, expect, it } from 'vitest';

import type { TriggerRow } from '../../../src/db/schema';
import { buildTriggerActionContext } from '../../../src/services/trigger-action-context';

const trigger = {
  id: 'trigger-1',
  projectId: 'project-1',
  name: 'Source-aware trigger',
  description: 'Test context',
  triggerCount: 4,
  cronTimezone: 'UTC',
} as TriggerRow;

const project = {
  id: 'project-1',
  name: 'Context Project',
  repository: 'sam/context-project',
};

const base = {
  trigger,
  project,
  now: new Date('2026-07-13T12:00:00.000Z'),
  executionId: 'execution-5',
  sequenceNumber: 5,
};

describe('manual trigger action context', () => {
  it('builds a GitHub context for GitHub previews and runs', () => {
    const context = buildTriggerActionContext({
      ...base,
      source: { sourceType: 'github', eventType: 'pull_request' },
    });

    expect(context).toMatchObject({
      github: {
        event: 'pull_request',
        action: 'manual',
        actor: 'manual',
        repository: 'sam/context-project',
      },
      execution: { id: 'execution-5', sequenceNumber: '5' },
    });
    expect(context).not.toHaveProperty('schedule');
  });

  it('builds a redacted webhook context from optional manual sample input', () => {
    const context = buildTriggerActionContext({
      ...base,
      source: {
        sourceType: 'webhook',
        config: {
          sourceLabel: 'release-system',
          filterMode: 'all',
          filters: [],
          includedHeaders: ['x-event-type'],
          tokenLastFour: 'abcd',
          tokenCreatedAt: '2026-07-13T00:00:00.000Z',
          tokenRotatedAt: null,
        },
      },
      preview: {
        payload: { deployment: { id: 'dep-42' } },
        headers: { 'x-event-type': 'deployment.failed', authorization: 'secret' },
      },
    });

    expect(context).toMatchObject({
      webhook: {
        body: { deployment: { id: 'dep-42' } },
        headers: { 'x-event-type': 'deployment.failed' },
        sourceLabel: 'release-system',
      },
    });
    expect(JSON.stringify(context)).not.toContain('secret');
    expect(context).not.toHaveProperty('schedule');
  });
});
