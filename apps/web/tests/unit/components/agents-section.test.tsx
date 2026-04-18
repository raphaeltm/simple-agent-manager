import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentCredentials: vi.fn(),
  getAgentSettings: vi.fn(),
  saveAgentCredential: vi.fn(),
  deleteAgentCredential: vi.fn(),
  saveAgentSettings: vi.fn(),
  deleteAgentSettings: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgents: mocks.listAgents,
  listAgentCredentials: mocks.listAgentCredentials,
  getAgentSettings: mocks.getAgentSettings,
  saveAgentCredential: mocks.saveAgentCredential,
  deleteAgentCredential: mocks.deleteAgentCredential,
  saveAgentSettings: mocks.saveAgentSettings,
  deleteAgentSettings: mocks.deleteAgentSettings,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { AgentsSection } from '../../../src/components/AgentsSection';

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

function makeSettings(agentType: string, overrides: Record<string, unknown> = {}) {
  return {
    agentType,
    model: null,
    permissionMode: null,
    allowedTools: null,
    deniedTools: null,
    additionalEnv: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('AgentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgents.mockResolvedValue(AGENT_LIST);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
    mocks.getAgentSettings.mockImplementation((agentType: string) =>
      Promise.resolve(makeSettings(agentType)),
    );
  });

  it('renders one card per agent', async () => {
    render(<AgentsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-card-claude-code')).toBeInTheDocument();
      expect(screen.getByTestId('agent-card-openai-codex')).toBeInTheDocument();
    });
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
  });

  it('shows Connection and Configuration section headers for each card', async () => {
    render(<AgentsSection />);
    await waitFor(() => {
      expect(screen.getAllByText('Connection').length).toBe(2);
      expect(screen.getAllByText('Configuration').length).toBe(2);
    });
  });

  it('calls saveAgentSettings when the Save Settings button is clicked', async () => {
    mocks.saveAgentSettings.mockResolvedValue(
      makeSettings('claude-code', { permissionMode: 'default' }),
    );

    render(<AgentsSection />);
    await waitFor(() => {
      const defaultRadio = screen.getByTestId(
        'permission-mode-claude-code-default',
      ) as HTMLInputElement;
      expect(defaultRadio.checked).toBe(true);
    });

    fireEvent.click(screen.getByTestId('permission-mode-claude-code-acceptEdits'));
    fireEvent.click(screen.getByTestId('save-settings-claude-code'));

    await waitFor(() => {
      expect(mocks.saveAgentSettings).toHaveBeenCalledWith('claude-code', {
        model: null,
        permissionMode: 'acceptEdits',
      });
    });
  });

  it('calls deleteAgentSettings when the reset button is clicked', async () => {
    mocks.getAgentSettings.mockImplementation((agentType: string) =>
      Promise.resolve(
        makeSettings(agentType, {
          model: 'claude-opus-4-6',
          permissionMode: 'acceptEdits',
        }),
      ),
    );
    mocks.deleteAgentSettings.mockResolvedValue(undefined);

    render(<AgentsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('reset-settings-claude-code')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('reset-settings-claude-code'));

    await waitFor(() => {
      expect(mocks.deleteAgentSettings).toHaveBeenCalledWith('claude-code');
    });
  });

  it('displays an error state when the list call fails', async () => {
    mocks.listAgents.mockRejectedValue(new Error('Network error'));
    render(<AgentsSection />);
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });
});
