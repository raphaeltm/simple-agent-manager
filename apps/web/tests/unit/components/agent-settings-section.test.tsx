import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getAgentSettings: vi.fn(),
  saveAgentSettings: vi.fn(),
  deleteAgentSettings: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listAgents: mocks.listAgents,
  getAgentSettings: mocks.getAgentSettings,
  saveAgentSettings: mocks.saveAgentSettings,
  deleteAgentSettings: mocks.deleteAgentSettings,
}));

import { AgentSettingsSection } from '../../../src/components/AgentSettingsSection';

describe('AgentSettingsSection', () => {
  const mockAgents = {
    agents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        description: 'Test agent',
        supportsAcp: true,
        configured: true,
        credentialHelpUrl: 'https://example.com',
      },
      {
        id: 'openai-codex',
        name: 'OpenAI Codex',
        description: 'Another agent',
        supportsAcp: true,
        configured: false,
        credentialHelpUrl: 'https://example.com',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgents.mockResolvedValue(mockAgents);
    mocks.getAgentSettings.mockResolvedValue({
      agentType: 'claude-code',
      model: null,
      permissionMode: null,
      allowedTools: null,
      deniedTools: null,
      additionalEnv: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it('renders settings cards for each agent', async () => {
    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
      expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
    });
  });

  it('shows model input fields for each agent', async () => {
    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('model-input-claude-code')).toBeInTheDocument();
      expect(screen.getByTestId('model-input-openai-codex')).toBeInTheDocument();
    });
  });

  it('shows permission mode radio buttons', async () => {
    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('permission-mode-claude-code-default')).toBeInTheDocument();
      expect(screen.getByTestId('permission-mode-claude-code-acceptEdits')).toBeInTheDocument();
      expect(screen.getByTestId('permission-mode-claude-code-bypassPermissions')).toBeInTheDocument();
    });
  });

  it('loads existing settings from API', async () => {
    mocks.getAgentSettings.mockImplementation((agentType: string) => {
      if (agentType === 'claude-code') {
        return Promise.resolve({
          agentType: 'claude-code',
          model: 'claude-opus-4-6',
          permissionMode: 'acceptEdits',
          allowedTools: null,
          deniedTools: null,
          additionalEnv: null,
          createdAt: '2026-02-13T00:00:00Z',
          updatedAt: '2026-02-13T00:00:00Z',
        });
      }
      return Promise.resolve({
        agentType,
        model: null,
        permissionMode: null,
        allowedTools: null,
        deniedTools: null,
        additionalEnv: null,
        createdAt: null,
        updatedAt: null,
      });
    });

    render(<AgentSettingsSection />);

    await waitFor(() => {
      const modelInput = screen.getByTestId('model-input-claude-code') as HTMLInputElement;
      expect(modelInput.value).toBe('claude-opus-4-6');
    });

    // Check that acceptEdits radio is selected
    const acceptEditsRadio = screen.getByTestId('permission-mode-claude-code-acceptEdits') as HTMLInputElement;
    expect(acceptEditsRadio.checked).toBe(true);
  });

  it('shows warning when bypassPermissions is selected', async () => {
    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('permission-mode-claude-code-bypassPermissions')).toBeInTheDocument();
    });

    const bypassRadio = screen.getByTestId('permission-mode-claude-code-bypassPermissions');
    fireEvent.click(bypassRadio);

    expect(screen.getByText(/disables all safety prompts/i)).toBeInTheDocument();
  });

  it('calls saveAgentSettings on save', async () => {
    mocks.saveAgentSettings.mockResolvedValue({
      agentType: 'claude-code',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      allowedTools: null,
      deniedTools: null,
      additionalEnv: null,
      createdAt: '2026-02-13T00:00:00Z',
      updatedAt: '2026-02-13T00:00:00Z',
    });

    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('model-input-claude-code')).toBeInTheDocument();
    });

    const modelInput = screen.getByTestId('model-input-claude-code');
    fireEvent.change(modelInput, { target: { value: 'claude-opus-4-6' } });

    const saveButton = screen.getByTestId('save-settings-claude-code');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mocks.saveAgentSettings).toHaveBeenCalledWith('claude-code', {
        model: 'claude-opus-4-6',
        permissionMode: 'default',
      });
    });
  });

  it('calls deleteAgentSettings on reset', async () => {
    // Load initial settings with a model set
    mocks.getAgentSettings.mockImplementation((agentType: string) => {
      if (agentType === 'claude-code') {
        return Promise.resolve({
          agentType: 'claude-code',
          model: 'claude-opus-4-6',
          permissionMode: 'acceptEdits',
          allowedTools: null,
          deniedTools: null,
          additionalEnv: null,
          createdAt: '2026-02-13T00:00:00Z',
          updatedAt: '2026-02-13T00:00:00Z',
        });
      }
      return Promise.resolve({
        agentType,
        model: null,
        permissionMode: null,
        allowedTools: null,
        deniedTools: null,
        additionalEnv: null,
        createdAt: null,
        updatedAt: null,
      });
    });
    mocks.deleteAgentSettings.mockResolvedValue(undefined);

    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('reset-settings-claude-code')).toBeInTheDocument();
    });

    const resetButton = screen.getByTestId('reset-settings-claude-code');
    fireEvent.click(resetButton);

    await waitFor(() => {
      expect(mocks.deleteAgentSettings).toHaveBeenCalledWith('claude-code');
    });
  });

  it('displays error message on API failure', async () => {
    mocks.listAgents.mockRejectedValue(new Error('Network error'));

    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });
});
