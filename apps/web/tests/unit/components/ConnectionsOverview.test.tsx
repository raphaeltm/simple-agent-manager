import type { CCConsumerResolutionStatus } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getResolutionStatus: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getResolutionStatus: mocks.getResolutionStatus,
}));

import { ConnectionsOverview } from '../../../src/components/ConnectionsOverview';

function makeConsumer(overrides: Partial<CCConsumerResolutionStatus>): CCConsumerResolutionStatus {
  return {
    consumerId: 'claude-code',
    consumerKind: 'agent',
    consumerName: 'Claude Code',
    source: 'user-attachment',
    credentialName: 'My Key',
    credentialKind: 'api-key',
    halted: false,
    ...overrides,
  };
}

const MOCK_CONSUMERS: CCConsumerResolutionStatus[] = [
  makeConsumer({
    consumerId: 'claude-code',
    consumerName: 'Claude Code',
    source: 'user-attachment',
    credentialName: 'My Anthropic Key',
  }),
  makeConsumer({
    consumerId: 'openai-codex',
    consumerName: 'Codex',
    source: 'unresolved',
    credentialName: null,
    credentialKind: null,
  }),
  makeConsumer({
    consumerId: 'hetzner',
    consumerKind: 'compute',
    consumerName: 'Hetzner Cloud',
    source: 'unresolved',
    credentialName: null,
  }),
];

function renderOverview(props: Partial<React.ComponentProps<typeof ConnectionsOverview>> = {}) {
  return render(
    <MemoryRouter>
      <ConnectionsOverview {...props} />
    </MemoryRouter>
  );
}

describe('ConnectionsOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolutionStatus.mockResolvedValue({ consumers: MOCK_CONSUMERS });
  });

  it('renders agent and compute consumer rows after loading', async () => {
    renderOverview();

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Hetzner Cloud')).toBeInTheDocument();
    expect(screen.getByText(/My Anthropic Key/)).toBeInTheDocument();
  });

  it('renders resolution badges for each consumer', async () => {
    renderOverview();

    await waitFor(() => {
      expect(screen.getByText('Your default')).toBeInTheDocument();
    });

    // Two unresolved consumers (Codex + Hetzner)
    expect(screen.getAllByText('Not configured')).toHaveLength(2);
  });

  it('calls onConnect when Make default is clicked for an unconfigured agent', async () => {
    const onConnect = vi.fn();
    renderOverview({ onConnect });

    await waitFor(() => {
      expect(screen.getByText('Codex')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Make default' })[0]);

    expect(onConnect).toHaveBeenCalledWith('openai-codex', 'agent');
  });

  it('renders configured agent row actions', async () => {
    const onReplace = vi.fn();
    const onDisconnect = vi.fn();
    renderOverview({ onReplace, onDisconnect });

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Replace default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ consumerId: 'claude-code' }));
    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ consumerId: 'claude-code' })
    );
  });

  it('calls onConnect when Make default is clicked for an unconfigured compute consumer', async () => {
    const onConnect = vi.fn();
    renderOverview({ onConnect });

    await waitFor(() => {
      expect(screen.getByText('Hetzner Cloud')).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole('button', { name: 'Make default' });
    fireEvent.click(buttons[1]);

    expect(onConnect).toHaveBeenCalledWith('hetzner', 'compute');
  });

  it('renders configured compute row actions', async () => {
    const onReplace = vi.fn();
    const onDisconnect = vi.fn();
    mocks.getResolutionStatus.mockResolvedValue({
      consumers: [
        makeConsumer({
          consumerId: 'hetzner',
          consumerKind: 'compute',
          consumerName: 'Hetzner Cloud',
          source: 'user-attachment',
          credentialName: 'Hetzner default',
          credentialKind: 'cloud-provider',
        }),
      ],
    });

    renderOverview({ onReplace, onDisconnect });

    await waitFor(() => {
      expect(screen.getByText('Hetzner Cloud')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Replace default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ consumerId: 'hetzner' }));
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ consumerId: 'hetzner' }));
  });

  it('shows project override for inherited compute defaults in project scope', async () => {
    const onProjectOverride = vi.fn();
    mocks.getResolutionStatus.mockResolvedValue({
      consumers: [
        makeConsumer({
          consumerId: 'hetzner',
          consumerKind: 'compute',
          consumerName: 'Hetzner Cloud',
          source: 'user-attachment',
          credentialName: 'Hetzner default',
          credentialKind: 'cloud-provider',
        }),
      ],
    });

    renderOverview({ projectId: 'proj-1', onProjectOverride });

    await waitFor(() => {
      expect(screen.getByText('Hetzner Cloud')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project override' }));

    expect(screen.queryByRole('button', { name: 'Replace default' })).not.toBeInTheDocument();
    expect(onProjectOverride).toHaveBeenCalledWith(expect.objectContaining({ consumerId: 'hetzner' }));
  });

  it('does not render a Connect button for configured consumers', async () => {
    const onConnect = vi.fn();
    renderOverview({ onConnect });

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    const connectButtons = screen.queryAllByRole('button', { name: 'Connect' });
    expect(connectButtons).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Make default' }).length).toBeGreaterThan(0);
  });

  it('shows error alert and retries on click', async () => {
    mocks.getResolutionStatus.mockRejectedValueOnce(new Error('Network error'));
    renderOverview();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });

    // Click retry
    mocks.getResolutionStatus.mockResolvedValueOnce({ consumers: MOCK_CONSUMERS });
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    expect(mocks.getResolutionStatus).toHaveBeenCalledTimes(2);
  });

  it('passes projectId to getResolutionStatus', async () => {
    renderOverview({ projectId: 'proj-1' });

    await waitFor(() => {
      expect(mocks.getResolutionStatus).toHaveBeenCalledWith('proj-1');
    });
  });

  it('shows empty state when no agents available', async () => {
    mocks.getResolutionStatus.mockResolvedValue({
      consumers: [
        makeConsumer({
          consumerId: 'hetzner',
          consumerKind: 'compute',
          consumerName: 'Hetzner',
          source: 'unresolved',
          credentialName: null,
        }),
      ],
    });
    renderOverview();

    await waitFor(() => {
      expect(screen.getByText('No agents available.')).toBeInTheDocument();
    });
  });
});
