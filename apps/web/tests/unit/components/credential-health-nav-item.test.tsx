import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjectCredentialAttributionHealth: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectCredentialAttributionHealth: mocks.getProjectCredentialAttributionHealth,
}));

import { CredentialHealthNavItem } from '../../../src/components/CredentialHealthNavItem';

describe('CredentialHealthNavItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectCredentialAttributionHealth.mockResolvedValue({
      projectId: 'proj-1',
      counts: {
        resources: 1,
        personalResources: 1,
        personalCredentials: 2,
        projectCoveredCredentials: 0,
        unknownCredentials: 0,
      },
      resources: [
        {
          id: 'trigger-1',
          projectId: 'proj-1',
          kind: 'trigger',
          title: 'Daily review',
          subtitle: '0 9 * * *',
          href: '/projects/proj-1/triggers/trigger-1',
          createdBy: { id: 'coworker', name: 'Coworker', email: 'co@example.com', avatarUrl: null },
          checks: [
            {
              consumerKind: 'agent',
              consumerTarget: 'opencode',
              label: 'Agent credential (opencode)',
              source: 'personal',
              owner: { id: 'coworker', name: 'Coworker', email: 'co@example.com', avatarUrl: null },
              projectCredential: null,
              fixHref: '/projects/proj-1/settings',
              warning: "This runs on Coworker's personal key.",
            },
            {
              consumerKind: 'compute',
              consumerTarget: 'inherited-provider',
              label: 'Compute credential (inherited-provider)',
              source: 'personal',
              owner: { id: 'coworker', name: 'Coworker', email: 'co@example.com', avatarUrl: null },
              projectCredential: null,
              fixHref: '/projects/proj-1/settings',
              warning: "This runs on Coworker's personal key.",
            },
          ],
        },
        {
          id: 'node-1',
          projectId: 'proj-1',
          kind: 'node',
          title: 'Production runner node',
          subtitle: 'active',
          href: '/projects/proj-1/nodes/node-1',
          createdBy: { id: 'coworker', name: 'Coworker', email: 'co@example.com', avatarUrl: null },
          checks: [
            {
              consumerKind: 'compute',
              consumerTarget: 'hetzner',
              label: 'Compute credential (hetzner)',
              source: 'personal',
              owner: { id: 'coworker', name: 'Coworker', email: 'co@example.com', avatarUrl: null },
              projectCredential: null,
              fixHref: '/projects/proj-1/nodes/node-1',
              warning: "This node runs on Coworker's personal key.",
            },
          ],
        },
      ],
    });
  });

  it('shows compact counts and opens the detail modal', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CredentialHealthNavItem projectId="proj-1" />
      </MemoryRouter>
    );

    const button = await screen.findByRole('button', { name: /credential attribution health/i });
    expect(button).toHaveTextContent('2 resources / 2 keys');

    await user.click(button);
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /credential attribution/i })).toBeInTheDocument();
    });
    expect(screen.getByText('Daily review')).toBeInTheDocument();
    expect(screen.getByText('Nodes')).toBeInTheDocument();
    expect(screen.getByText('Production runner node')).toBeInTheDocument();
    expect(screen.getAllByText("This runs on Coworker's personal key.")).toHaveLength(2);
  });
});
