import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentCredentials: vi.fn(),
  listProjectAgentCredentials: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgents: mocks.listAgents,
  listAgentCredentials: mocks.listAgentCredentials,
  listProjectAgentCredentials: mocks.listProjectAgentCredentials,
  updateProject: mocks.updateProject,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    addToast: vi.fn(),
  }),
}));

import { ProjectAgentsSection } from '../../../src/components/ProjectAgentsSection';

// The account summary links to Project settings → Accounts, so render in a router.
function renderSection(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const AGENT_LIST = {
  agents: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: 'Agentic coding from Anthropic',
      supportsAcp: true,
      configured: true,
      credentialHelpUrl: 'https://console.anthropic.com',
    },
    {
      id: 'openai-codex',
      name: 'OpenAI Codex',
      description: 'Codex CLI',
      supportsAcp: true,
      configured: false,
      credentialHelpUrl: 'https://platform.openai.com',
    },
  ],
};

function makeUserCred(agentType = 'claude-code') {
  return {
    id: `user-cred-${agentType}`,
    agentType,
    credentialKind: 'api-key',
    maskedKey: 'sk-****abcd',
    isActive: true,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  };
}

describe('ProjectAgentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgents.mockResolvedValue(AGENT_LIST);
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [makeUserCred('claude-code')],
    });
    mocks.listProjectAgentCredentials.mockResolvedValue({ credentials: [] });
  });

  it('renders one card per agent', async () => {
    renderSection(
      <ProjectAgentsSection projectId="proj-1" initialAgentDefaults={null} onUpdated={vi.fn()} />
    );
    await waitFor(() => {
      expect(screen.getByTestId('project-agent-card-claude-code')).toBeInTheDocument();
      expect(screen.getByTestId('project-agent-card-openai-codex')).toBeInTheDocument();
    });
  });

  it('summarises which account the project uses and links to Accounts', async () => {
    renderSection(
      <ProjectAgentsSection projectId="proj-1" initialAgentDefaults={null} onUpdated={vi.fn()} />
    );

    const claude = await screen.findByTestId('project-agent-card-claude-code');
    expect(within(claude).getByText('Your default account')).toBeInTheDocument();
    expect(within(claude).getByText(/This project uses your default account/)).toBeInTheDocument();
    expect(within(claude).getByRole('link', { name: 'Manage in Accounts' })).toHaveAttribute(
      'href',
      '/projects/proj-1/settings/accounts'
    );

    const codex = screen.getByTestId('project-agent-card-openai-codex');
    expect(within(codex).getByText('No account')).toBeInTheDocument();
    // Connecting and removing accounts moved to Accounts: no credential editor here.
    expect(within(claude).queryByRole('textbox')).toBeNull();
    expect(within(claude).queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('shows a pinned account when the project has its own', async () => {
    mocks.listProjectAgentCredentials.mockResolvedValue({
      credentials: [
        {
          id: 'proj-cred-claude',
          agentType: 'claude-code',
          credentialKind: 'api-key',
          maskedKey: 'sk-****proj',
          isActive: true,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
        },
      ],
    });
    renderSection(
      <ProjectAgentsSection projectId="proj-1" initialAgentDefaults={null} onUpdated={vi.fn()} />
    );

    const claude = await screen.findByTestId('project-agent-card-claude-code');
    await waitFor(() => expect(within(claude).getByText('Pinned account')).toBeInTheDocument());
    expect(within(claude).getByText(/uses an account pinned to it/)).toBeInTheDocument();
  });

  it('calls updateProject when Save Override is clicked in Configuration', async () => {
    const user = userEvent.setup();
    mocks.updateProject.mockResolvedValue({
      id: 'proj-1',
      agentDefaults: {
        'claude-code': { model: null, permissionMode: 'acceptEdits' },
      },
    });
    const onUpdated = vi.fn();

    renderSection(
      <ProjectAgentsSection projectId="proj-1" initialAgentDefaults={null} onUpdated={onUpdated} />
    );

    await waitFor(() => {
      expect(screen.getByTestId('project-agent-permission-select-claude-code')).toBeInTheDocument();
    });

    await user.selectOptions(
      screen.getByTestId('project-agent-permission-select-claude-code'),
      'acceptEdits'
    );

    const saveButton = screen.getByTestId('project-agent-save-claude-code');
    await waitFor(() => {
      expect(saveButton).toBeEnabled();
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', {
        agentDefaults: {
          'claude-code': { model: null, permissionMode: 'acceptEdits' },
        },
      });
    });
    expect(onUpdated).toHaveBeenCalled();
  });

  it('clears the project override by sending null when the last override is removed', async () => {
    const onUpdated = vi.fn();
    mocks.updateProject.mockResolvedValue({ id: 'proj-1', agentDefaults: null });

    renderSection(
      <ProjectAgentsSection
        projectId="proj-1"
        initialAgentDefaults={{
          'claude-code': { model: 'claude-opus-4-6', permissionMode: 'acceptEdits' },
        }}
        onUpdated={onUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('project-agent-clear-claude-code')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('project-agent-clear-claude-code'));

    await waitFor(() => {
      expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', {
        agentDefaults: null,
      });
    });
    expect(onUpdated).toHaveBeenCalledWith(null);
  });

  it('displays an error state when listing fails', async () => {
    mocks.listAgents.mockRejectedValue(new Error('Boom'));
    renderSection(
      <ProjectAgentsSection projectId="proj-1" initialAgentDefaults={null} onUpdated={vi.fn()} />
    );
    await waitFor(() => {
      expect(screen.getByText('Boom')).toBeInTheDocument();
    });
  });

  it('displays an error alert when Save Override fails', async () => {
    const user = userEvent.setup();
    mocks.updateProject.mockRejectedValue(new Error('Network save failed'));

    renderSection(
      <ProjectAgentsSection projectId="proj-1" initialAgentDefaults={null} onUpdated={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByTestId('project-agent-permission-select-claude-code')).toBeInTheDocument();
    });

    await user.selectOptions(
      screen.getByTestId('project-agent-permission-select-claude-code'),
      'acceptEdits'
    );

    const saveButton = screen.getByTestId('project-agent-save-claude-code');
    await waitFor(() => {
      expect(saveButton).toBeEnabled();
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText('Network save failed')).toBeInTheDocument();
    });
  });
});
