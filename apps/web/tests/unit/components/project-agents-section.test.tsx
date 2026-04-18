import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentCredentials: vi.fn(),
  listProjectAgentCredentials: vi.fn(),
  saveProjectAgentCredential: vi.fn(),
  deleteProjectAgentCredential: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgents: mocks.listAgents,
  listAgentCredentials: mocks.listAgentCredentials,
  listProjectAgentCredentials: mocks.listProjectAgentCredentials,
  saveProjectAgentCredential: mocks.saveProjectAgentCredential,
  deleteProjectAgentCredential: mocks.deleteProjectAgentCredential,
  updateProject: mocks.updateProject,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { ProjectAgentsSection } from '../../../src/components/ProjectAgentsSection';

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
    render(
      <ProjectAgentsSection
        projectId="proj-1"
        initialAgentDefaults={null}
        onUpdated={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('project-agent-card-claude-code')).toBeInTheDocument();
      expect(screen.getByTestId('project-agent-card-openai-codex')).toBeInTheDocument();
    });
  });

  it('shows "Inheriting user credential" when there is a user cred but no project override', async () => {
    render(
      <ProjectAgentsSection
        projectId="proj-1"
        initialAgentDefaults={null}
        onUpdated={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Inheriting user credential/i).length).toBeGreaterThan(0);
    });
  });

  it('calls updateProject when Save Override is clicked in Configuration', async () => {
    mocks.updateProject.mockResolvedValue({
      id: 'proj-1',
      agentDefaults: {
        'claude-code': { model: null, permissionMode: 'acceptEdits' },
      },
    });
    const onUpdated = vi.fn();

    render(
      <ProjectAgentsSection
        projectId="proj-1"
        initialAgentDefaults={null}
        onUpdated={onUpdated}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('project-agent-permission-select-claude-code')).toBeInTheDocument();
    });

    fireEvent.change(
      screen.getByTestId('project-agent-permission-select-claude-code'),
      { target: { value: 'acceptEdits' } },
    );
    fireEvent.click(screen.getByTestId('project-agent-save-claude-code'));

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

    render(
      <ProjectAgentsSection
        projectId="proj-1"
        initialAgentDefaults={{
          'claude-code': { model: 'claude-opus-4-6', permissionMode: 'acceptEdits' },
        }}
        onUpdated={onUpdated}
      />,
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
    render(
      <ProjectAgentsSection
        projectId="proj-1"
        initialAgentDefaults={null}
        onUpdated={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Boom')).toBeInTheDocument();
    });
  });
});
