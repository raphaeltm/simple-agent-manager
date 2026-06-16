import type { CCConsumerResolutionStatus } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteProjectAgentCredential: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  lastOverviewProps: null as null | {
    onDisconnect: (consumer: CCConsumerResolutionStatus) => void;
    onValidate: (consumer: CCConsumerResolutionStatus) => void;
  },
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  deleteProjectAgentCredential: mocks.deleteProjectAgentCredential,
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
});
