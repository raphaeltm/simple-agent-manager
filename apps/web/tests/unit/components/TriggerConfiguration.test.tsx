import type { TriggerResponse } from '@simple-agent-manager/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TriggerConfiguration } from '../../../src/components/triggers/TriggerConfiguration';

function makeGitHubTrigger(eventType: 'issue_comment' | 'issues'): TriggerResponse {
  return {
    id: 'trigger-1',
    projectId: 'project-1',
    userId: 'user-1',
    name: 'Issue Reviewer',
    description: null,
    status: 'active',
    sourceType: 'github',
    cronExpression: null,
    cronTimezone: 'UTC',
    cronHumanReadable: null,
    skipIfRunning: true,
    promptTemplate: 'Review the issue',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    nextFireAt: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: '2026-07-16T16:47:03Z',
    updatedAt: '2026-07-16T16:47:03Z',
    githubConfig: {
      eventType,
      filters: { commandPrefix: '/sam' },
    },
  } as TriggerResponse;
}

function commandPrefixRow() {
  const label = screen.getByText('Command Prefix', { exact: true });
  const row = label.parentElement;
  expect(row).not.toBeNull();
  return within(row as HTMLElement);
}

describe('TriggerConfiguration', () => {
  it('does not present a stored command prefix as active for non-comment events', () => {
    render(<TriggerConfiguration trigger={makeGitHubTrigger('issues')} />);

    expect(commandPrefixRow().getByText('None', { exact: true })).toBeInTheDocument();
    expect(commandPrefixRow().queryByText('/sam', { exact: true })).not.toBeInTheDocument();
  });

  it('presents the command prefix for issue_comment events', () => {
    render(<TriggerConfiguration trigger={makeGitHubTrigger('issue_comment')} />);

    expect(commandPrefixRow().getByText('/sam', { exact: true })).toBeInTheDocument();
  });
});
