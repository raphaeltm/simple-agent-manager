import { describe, expect, it } from 'vitest';

import { PROJECT_EVENT_SUBSCRIPTION_TOOLS } from '../../../src/routes/mcp/tool-definitions-event-subscription-tools';

describe('project event subscription guidance', () => {
  const create = PROJECT_EVENT_SUBSCRIPTION_TOOLS.find(
    (tool) => tool.name === 'create_project_event_subscription'
  )!;

  it('documents exact GitHub CI completion types and full commit subjects', () => {
    for (const eventType of [
      'check_run.completed',
      'check_suite.completed',
      'workflow_run.completed',
    ]) {
      expect(create.description).toContain(eventType);
    }
    expect(create.description).toContain('full 40-character PR head SHA');
    expect(create.description).toContain('Bare event names and abbreviated SHAs do not match');
  });

  it('documents race reconciliation and independent expiry recovery', () => {
    expect(create.description).toContain('recheck after creation');
    expect(create.description).toContain('after every wake');
    expect(create.description).toContain('not proof that all required checks passed');
    expect(create.description).toContain('Expiry does not wake');
    expect(create.description).toContain('independently supported bounded fallback');
    expect(create.description).toContain('Cancel obsolete subscriptions');
  });

  it('explains how to find expired waits hidden by the active default', () => {
    const list = PROJECT_EVENT_SUBSCRIPTION_TOOLS.find(
      (tool) => tool.name === 'list_project_event_subscriptions'
    )!;
    expect(list.description).toContain('state=any');
    expect(list.description).toContain('expired or cancelled');
  });
});
