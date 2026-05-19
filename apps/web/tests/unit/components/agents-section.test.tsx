import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentCredentials: vi.fn(),
  getAgentSettings: vi.fn(),
  saveAgentCredential: vi.fn(),
  deleteAgentCredential: vi.fn(),
  deleteAgentCredentialByKind: vi.fn(),
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
  deleteAgentCredentialByKind: mocks.deleteAgentCredentialByKind,
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
    {
      id: 'amp',
      name: 'Amp',
      description: "Sourcegraph's managed AI coding agent",
      supportsAcp: true,
      configured: false,
      credentialHelpUrl: 'https://ampcode.com/settings',
    },
    {
      id: 'google-gemini',
      name: 'Gemini CLI',
      description: 'Google coding agent',
      supportsAcp: true,
      configured: false,
      credentialHelpUrl: 'https://aistudio.google.com/apikey',
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
    opencodeProvider: null,
    opencodeBaseUrl: null,
    opencodeProviderName: null,
    providerMode: null,
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
      expect(screen.getByTestId('agent-card-amp')).toBeInTheDocument();
      expect(screen.getByTestId('agent-card-google-gemini')).toBeInTheDocument();
    });
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
    expect(screen.getByText('Amp')).toBeInTheDocument();
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument();
  });

  it('shows Connection and Configuration section headers for each card', async () => {
    render(<AgentsSection />);
    await waitFor(() => {
      expect(screen.getAllByText('Connection').length).toBe(4);
      expect(screen.getAllByText('Configuration').length).toBe(4);
    });
  });

  it('saves Gemini CLI model settings from the agent card', async () => {
    mocks.getAgentSettings.mockImplementation((agentType: string) =>
      Promise.resolve(
        makeSettings(agentType, {
          permissionMode: agentType === 'google-gemini' ? 'default' : null,
        }),
      ),
    );
    mocks.saveAgentSettings.mockResolvedValue(
      makeSettings('google-gemini', {
        model: 'gemini-2.5-pro',
        permissionMode: 'default',
      }),
    );

    render(<AgentsSection />);
    const modelInput = await screen.findByTestId('model-input-google-gemini');
    fireEvent.change(modelInput, { target: { value: 'gemini-2.5-pro' } });

    await waitFor(() => {
      expect(
        (screen.getByTestId('save-settings-google-gemini') as HTMLButtonElement).disabled
      ).toBe(false);
    });

    fireEvent.click(screen.getByTestId('save-settings-google-gemini'));

    await waitFor(() => {
      expect(mocks.saveAgentSettings).toHaveBeenCalledWith('google-gemini', {
        model: 'gemini-2.5-pro',
        permissionMode: 'default',
      });
    });
  });

  it('calls saveAgentSettings when the Save Settings button is clicked', async () => {
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [
        {
          id: 'cred-claude',
          agentType: 'claude-code',
          credentialKind: 'api-key',
          maskedKey: 'sk-****abcd',
          isActive: true,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
        },
      ],
    });
    mocks.getAgentSettings.mockImplementation((agentType: string) =>
      Promise.resolve(
        makeSettings(agentType, {
          permissionMode: agentType === 'claude-code' ? 'plan' : null,
        }),
      ),
    );
    mocks.saveAgentSettings.mockResolvedValue(
      makeSettings('claude-code', { permissionMode: 'default' }),
    );

    render(<AgentsSection />);
    await waitFor(() => {
      const planRadio = screen.getByTestId(
        'permission-mode-claude-code-plan',
      ) as HTMLInputElement;
      expect(planRadio.checked).toBe(true);
    });

    fireEvent.click(screen.getByTestId('permission-mode-claude-code-acceptEdits'));

    // Wait for the save button to become enabled (hasChanges = true) before clicking,
    // since async state updates from loadData() can race with the radio click
    await waitFor(() => {
      expect(
        (screen.getByTestId('save-settings-claude-code') as HTMLButtonElement).disabled
      ).toBe(false);
    });

    fireEvent.click(screen.getByTestId('save-settings-claude-code'));

    await waitFor(() => {
      expect(mocks.saveAgentSettings).toHaveBeenCalledWith('claude-code', {
        model: null,
        permissionMode: 'acceptEdits',
        providerMode: null,
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

  it('deletes only the active credential kind and keeps a remaining credential configured', async () => {
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [
        {
          id: 'cred-claude',
          agentType: 'claude-code',
          credentialKind: 'api-key',
          maskedKey: 'sk-****abcd',
          isActive: true,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
        },
        {
          id: 'cred-claude-oauth',
          agentType: 'claude-code',
          credentialKind: 'oauth-token',
          maskedKey: 'oauth-****wxyz',
          isActive: false,
          label: 'Pro/Max Subscription',
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
        },
      ],
    });
    mocks.deleteAgentCredentialByKind.mockResolvedValue(undefined);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    try {
      render(<AgentsSection />);
      await waitFor(() => {
        expect(screen.getByTestId('agent-card-claude-code')).toBeInTheDocument();
      });

      const card = screen.getByTestId('agent-card-claude-code');
      const removeButton = await waitFor(() => {
        const btn = card.querySelector('button.text-danger') as HTMLButtonElement | null;
        expect(btn).not.toBeNull();
        return btn!;
      });

      fireEvent.click(removeButton);

      await waitFor(() => {
        expect(mocks.deleteAgentCredentialByKind).toHaveBeenCalledWith('claude-code', 'api-key');
        expect(mocks.deleteAgentCredential).not.toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByText('oauth-****wxyz')).toBeInTheDocument();
        expect(screen.getByText('Pro/Max Subscription')).toBeInTheDocument();
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
