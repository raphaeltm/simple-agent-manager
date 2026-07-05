import type { TriggerResponse } from '@simple-agent-manager/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TriggerCredentialWarning } from '../../../src/components/triggers/TriggerCredentialWarning';

function makeTrigger(): TriggerResponse {
  return {
    id: 'trigger-1',
    projectId: 'proj-1',
    userId: 'coworker',
    name: 'Daily review',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: 'Run review',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: null,
    triggerCount: 0,
    nextFireAt: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    credentialAttribution: {
      hasPersonalWarning: true,
      checks: [
        {
          consumerKind: 'agent',
          consumerTarget: 'opencode',
          label: 'Agent credential (opencode)',
          source: 'personal',
          owner: { id: 'coworker', name: 'Raphael', email: 'r@example.com', avatarUrl: null },
          projectCredential: null,
          fixHref: '/projects/proj-1/settings',
          warning: "This runs on Raphael's personal key.",
        },
      ],
    },
  };
}

describe('TriggerCredentialWarning', () => {
  it('renders personal key attribution without secret material', () => {
    render(<TriggerCredentialWarning trigger={makeTrigger()} />);

    expect(screen.getByText('Personal credential attribution')).toBeInTheDocument();
    expect(screen.getByText("This runs on Raphael's personal key.")).toBeInTheDocument();
    expect(screen.queryByText(/secret|token|sk-/i)).not.toBeInTheDocument();
  });
});
