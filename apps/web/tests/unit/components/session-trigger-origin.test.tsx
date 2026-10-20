import type { TaskDetailResponse } from '@simple-agent-manager/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { SessionTriggerOrigin } from '../../../src/components/project-message-view/SessionTriggerOrigin';

describe('SessionTriggerOrigin', () => {
  it('links a chat an automation started to that automation and its runs', () => {
    const detail = {
      trigger: { id: 'trg-1', name: 'Nightly audit', cronHumanReadable: 'Every day at 2:30 AM' },
      triggerExecution: { id: 'ex-1', sequenceNumber: 12 },
    } as unknown as TaskDetailResponse;
    render(
      <MemoryRouter>
        <SessionTriggerOrigin projectId="p1" detail={detail} />
      </MemoryRouter>
    );
    expect(screen.getByText('Triggered by: Nightly audit')).toBeInTheDocument();
    expect(screen.getByText('Run #12')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View automation' })).toHaveAttribute(
      'href',
      '/projects/p1/automation/trigger/trg-1'
    );
    expect(screen.getByRole('link', { name: 'All runs' })).toHaveAttribute(
      'href',
      '/projects/p1/automation/trigger/trg-1#runs'
    );
  });
});
