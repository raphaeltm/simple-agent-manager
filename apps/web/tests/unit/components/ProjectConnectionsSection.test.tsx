import type { CCConsumerResolutionStatus } from '@simple-agent-manager/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteProjectAgentCredential: vi.fn(),
  deleteProjectCloudCredential: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  lastOverviewProps: null as null | {
    onProjectOverride: (consumer: CCConsumerResolutionStatus) => void;
    onDisconnect: (consumer: CCConsumerResolutionStatus) => void;
    onValidate: (consumer: CCConsumerResolutionStatus) => void;
  },
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  deleteProjectAgentCredential: mocks.deleteProjectAgentCredential,
  deleteProjectCloudCredential: mocks.deleteProjectCloudCredential,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({
    success: mocks.success,
    error: mocks.error,
    info: mocks.info,
    warning: mocks.warning,
  }),
}));

vi.mock('../../../src/components/ConnectionsOverview', () => ({
  ConnectionsOverview: (props: {
    onProjectOverride: (consumer: CCConsumerResolutionStatus) => void;
    onDisconnect: (consumer: CCConsumerResolutionStatus) => void;
    onValidate: (consumer: CCConsumerResolutionStatus) => void;
  }) => {
    mocks.lastOverviewProps = props;
    return <div data-testid="connections-overview">overview</div>;
  },
}));

vi.mock('../../../src/components/ConnectFlow', () => ({
  ConnectFlow: () => <div data-testid="connect-flow">connect-flow</div>,
}));

vi.mock('../../../src/components/CloudProviderConnectFlow', () => ({
  CloudProviderConnectFlow: (props: { initialProvider?: string; projectId?: string }) => (
    <div data-testid="cloud-provider-connect-flow">
      {props.initialProvider}:{props.projectId}
    </div>
  ),
}));

import { ProjectConnectionsSection } from '../../../src/components/project-settings/ProjectConnectionsSection';

const projectConsumer: CCConsumerResolutionStatus = {
  consumerId: 'openai-codex',
  consumerKind: 'agent',
  consumerName: 'Codex',
  source: 'project-attachment',
  credentialName: 'Project auth.json',
  credentialKind: 'auth-json',
  halted: false,
  validation: {
    status: 'valid',
    message: 'Auth JSON looks valid.',
  },
};

describe('ProjectConnectionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lastOverviewProps = null;
    mocks.deleteProjectAgentCredential.mockResolvedValue(undefined);
    mocks.deleteProjectCloudCredential.mockResolvedValue(undefined);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  });

  it('removes a project override through the project-scoped credential endpoint', async () => {
    const onUpdated = vi.fn();
    render(<ProjectConnectionsSection projectId="proj-1" onUpdated={onUpdated} />);

    expect(screen.getByTestId('connections-overview')).toBeInTheDocument();
    mocks.lastOverviewProps?.onDisconnect(projectConsumer);

    await waitFor(() => {
      expect(mocks.deleteProjectAgentCredential).toHaveBeenCalledWith(
        'proj-1',
        'openai-codex',
        'oauth-token'
      );
    });
    expect(mocks.success).toHaveBeenCalledWith('Codex project override removed');
    expect(onUpdated).toHaveBeenCalled();
  });

  it('validates a project credential without sending the secret to the client', () => {
    render(<ProjectConnectionsSection projectId="proj-1" onUpdated={vi.fn()} />);

    mocks.lastOverviewProps?.onValidate(projectConsumer);

    expect(mocks.success).toHaveBeenCalledWith('Auth JSON looks valid.');
    expect(mocks.deleteProjectAgentCredential).not.toHaveBeenCalled();
  });

  it('opens the cloud provider flow for project compute overrides', () => {
    render(<ProjectConnectionsSection projectId="proj-1" onUpdated={vi.fn()} />);

    act(() => {
      mocks.lastOverviewProps?.onProjectOverride({
        consumerId: 'hetzner',
        consumerKind: 'compute',
        consumerName: 'Hetzner Cloud',
        source: 'platform',
        credentialName: null,
        credentialKind: 'cloud-provider',
        halted: false,
      });
    });

    expect(screen.getByTestId('cloud-provider-connect-flow')).toHaveTextContent('hetzner:proj-1');
  });

  it('removes a project compute override through the project cloud endpoint', async () => {
    const onUpdated = vi.fn();
    render(<ProjectConnectionsSection projectId="proj-1" onUpdated={onUpdated} />);

    mocks.lastOverviewProps?.onDisconnect({
      consumerId: 'hetzner',
      consumerKind: 'compute',
      consumerName: 'Hetzner Cloud',
      source: 'project-attachment',
      credentialName: 'Project Hetzner',
      credentialKind: 'cloud-provider',
      halted: false,
    });

    await waitFor(() => {
      expect(mocks.deleteProjectCloudCredential).toHaveBeenCalledWith('proj-1', 'hetzner');
    });
    expect(mocks.success).toHaveBeenCalledWith('Hetzner Cloud project override removed');
    expect(onUpdated).toHaveBeenCalled();
  });
});
