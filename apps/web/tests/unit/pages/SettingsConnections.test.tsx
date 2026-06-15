import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getResolutionStatus: vi.fn(),
  saveAgentCredential: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getResolutionStatus: mocks.getResolutionStatus,
  saveAgentCredential: mocks.saveAgentCredential,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { SettingsConnections } from '../../../src/pages/SettingsConnections';

describe('SettingsConnections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolutionStatus.mockResolvedValue({
      consumers: [
        {
          consumerId: 'claude-code',
          consumerKind: 'agent',
          consumerName: 'Claude Code',
          source: 'unresolved',
          credentialName: null,
          halted: false,
        },
      ],
    });
  });

  it('renders ConnectionsOverview and "+ Connect an agent" button', async () => {
    render(<SettingsConnections />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    expect(screen.getByText('+ Connect an agent')).toBeInTheDocument();
  });

  it('shows ConnectFlow when "+ Connect an agent" is clicked', async () => {
    render(<SettingsConnections />);

    await waitFor(() => {
      expect(screen.getByText('+ Connect an agent')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ Connect an agent'));

    // ConnectFlow renders agent cards from AGENT_CATALOG
    await waitFor(() => {
      expect(screen.getByText('Agent')).toBeInTheDocument();
    });
  });

  it('shows ConnectFlow with pre-selected agent when Make default is clicked', async () => {
    render(<SettingsConnections />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    const connectBtn = screen.getByRole('button', { name: 'Make default' });
    fireEvent.click(connectBtn);

    // ConnectFlow should show with credential input visible (agent pre-selected)
    await waitFor(() => {
      expect(screen.getByLabelText(/API Key/i)).toBeInTheDocument();
    });
  });

  it('returns to overview after cancel', async () => {
    render(<SettingsConnections />);

    await waitFor(() => {
      expect(screen.getByText('+ Connect an agent')).toBeInTheDocument();
    });

    // Open connect flow
    fireEvent.click(screen.getByText('+ Connect an agent'));

    // Select an agent to get Cancel button
    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Claude Code'));

    // Click cancel
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelBtn);

    // Overview should be visible again
    await waitFor(() => {
      expect(screen.getByText('+ Connect an agent')).toBeInTheDocument();
    });
  });
});
