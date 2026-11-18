import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryTestWrapper } from '../../test-utils/query-test-utils';
import { type AccountRows, accountRows, mergeRows } from './accounts/fixtures';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  updateProject: vi.fn(),
  getResolutionStatus: vi.fn(),
  listCCCredentials: vi.fn(),
  listCCConfigurations: vi.fn(),
  listCCAttachments: vi.fn(),
  listProjects: vi.fn(),
  getMyCredentialLimits: vi.fn(),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  ...mocks,
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
  return render(<MemoryRouter>{ui}</MemoryRouter>, { wrapper: QueryTestWrapper });
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

const DEFAULT_CLAUDE = accountRows({
  id: 'work',
  name: 'Work key',
  kind: 'agent',
  target: 'claude-code',
  isDefault: true,
});

function serveAccounts(rows: AccountRows) {
  mocks.listCCCredentials.mockResolvedValue(rows.credentials);
  mocks.listCCConfigurations.mockResolvedValue(rows.configurations);
  mocks.listCCAttachments.mockResolvedValue(rows.attachments);
}

describe('ProjectAgentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgents.mockResolvedValue(AGENT_LIST);
    mocks.getResolutionStatus.mockResolvedValue({ consumers: [] });
    mocks.listProjects.mockResolvedValue({ projects: [{ id: 'proj-1', name: 'Project one' }] });
    mocks.getMyCredentialLimits.mockResolvedValue({ credentials: [] });
    serveAccounts(DEFAULT_CLAUDE);
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
    expect(
      await within(claude).findByText('This project uses your default account, Work key.')
    ).toBeInTheDocument();
    expect(within(claude).getByText('Your default account')).toBeInTheDocument();
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
    serveAccounts(
      mergeRows(
        DEFAULT_CLAUDE,
        accountRows({
          id: 'client',
          name: 'Client key',
          kind: 'agent',
          target: 'claude-code',
          pins: ['proj-1'],
        })
      )
    );
    renderSection(
      <ProjectAgentsSection projectId="proj-1" initialAgentDefaults={null} onUpdated={vi.fn()} />
    );

    const claude = await screen.findByTestId('project-agent-card-claude-code');
    await waitFor(() => expect(within(claude).getByText('Pinned account')).toBeInTheDocument());
    expect(
      within(claude).getByText('This project uses Client key, pinned to it.')
    ).toBeInTheDocument();
  });

  it('says the agent cannot run when the project’s pin is paused, as the Accounts tab does', async () => {
    serveAccounts(
      mergeRows(
        DEFAULT_CLAUDE,
        accountRows({
          id: 'paused',
          name: 'Paused key',
          kind: 'agent',
          target: 'claude-code',
          pins: [{ id: 'proj-1', active: false }],
        })
      )
    );
    renderSection(
      <ProjectAgentsSection projectId="proj-1" initialAgentDefaults={null} onUpdated={vi.fn()} />
    );

    const claude = await screen.findByTestId('project-agent-card-claude-code');
    expect(
      await within(claude).findByText('Its pinned account is paused, so this agent can’t run here.')
    ).toBeInTheDocument();
    expect(within(claude).getByText('Paused pin')).toBeInTheDocument();
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
