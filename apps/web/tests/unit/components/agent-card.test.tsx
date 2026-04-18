import type { AgentCredentialInfo, AgentInfo, AgentSettingsResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { AgentCard } from '../../../src/components/AgentCard';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Agentic coding from Anthropic',
    supportsAcp: true,
    configured: false,
    credentialHelpUrl: 'https://console.anthropic.com',
    ...overrides,
  } as AgentInfo;
}

function makeSettings(
  agentType = 'claude-code',
  overrides: Partial<AgentSettingsResponse> = {},
): AgentSettingsResponse {
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
  } as AgentSettingsResponse;
}

function makeCredential(
  overrides: Partial<AgentCredentialInfo> = {},
): AgentCredentialInfo {
  return {
    id: 'cred-1',
    agentType: 'claude-code',
    credentialKind: 'api-key',
    maskedKey: 'sk-***abcd',
    isActive: true,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  } as AgentCredentialInfo;
}

describe('AgentCard', () => {
  let onSaveCredential: ReturnType<typeof vi.fn>;
  let onDeleteCredential: ReturnType<typeof vi.fn>;
  let onSaveSettings: ReturnType<typeof vi.fn>;
  let onResetSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSaveCredential = vi.fn().mockResolvedValue(undefined);
    onDeleteCredential = vi.fn().mockResolvedValue(undefined);
    onSaveSettings = vi.fn().mockResolvedValue(undefined);
    onResetSettings = vi.fn().mockResolvedValue(undefined);
  });

  function renderCard(
    agent: AgentInfo,
    credentials: AgentCredentialInfo[] | null,
    settings: AgentSettingsResponse | null,
  ) {
    return render(
      <AgentCard
        agent={agent}
        credentials={credentials}
        settings={settings}
        onSaveCredential={onSaveCredential}
        onDeleteCredential={onDeleteCredential}
        onSaveSettings={onSaveSettings}
        onResetSettings={onResetSettings}
      />,
    );
  }

  it('renders agent name, description, and Connection + Configuration headers', () => {
    renderCard(makeAgent(), null, null);
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Agentic coding from Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('shows "Not configured" status when no credential exists', () => {
    renderCard(makeAgent(), null, null);
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
  });

  it('shows connected status when an active credential exists', () => {
    const agent = makeAgent({ configured: true });
    const creds = [makeCredential()];
    renderCard(agent, creds, null);
    // StatusBadge renders a non-disconnected label when credentials are active
    expect(screen.queryByText(/not configured/i)).not.toBeInTheDocument();
  });

  it('saves configuration via onSaveSettings when Save Settings is clicked', async () => {
    renderCard(makeAgent(), null, makeSettings());
    await waitFor(() => {
      const defaultRadio = screen.getByTestId(
        'permission-mode-claude-code-default',
      ) as HTMLInputElement;
      expect(defaultRadio.checked).toBe(true);
    });

    fireEvent.click(screen.getByTestId('permission-mode-claude-code-acceptEdits'));
    fireEvent.click(screen.getByTestId('save-settings-claude-code'));

    await waitFor(() => {
      expect(onSaveSettings).toHaveBeenCalledWith('claude-code', {
        model: null,
        permissionMode: 'acceptEdits',
      });
    });
  });

  it('calls onResetSettings when the reset button is clicked', async () => {
    renderCard(
      makeAgent(),
      null,
      makeSettings('claude-code', {
        model: 'claude-opus-4-6',
        permissionMode: 'acceptEdits',
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('reset-settings-claude-code')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('reset-settings-claude-code'));
    await waitFor(() => {
      expect(onResetSettings).toHaveBeenCalledWith('claude-code');
    });
  });

  it('saves credentials via onSaveCredential when the credential form is submitted', async () => {
    const user = userEvent.setup();
    renderCard(makeAgent(), null, null);
    const apiKeyInput = screen.getByPlaceholderText(/Enter your Claude Code API key/i);
    await user.type(apiKeyInput, 'sk-test-123');

    const saveButton = screen.getByRole('button', { name: /Save Credential/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(onSaveCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: 'claude-code',
          credentialKind: 'api-key',
          credential: 'sk-test-123',
        }),
      );
    });
  });

  it('shows OpenCode provider select ONLY for the opencode agent', () => {
    const { unmount } = renderCard(makeAgent(), null, makeSettings());
    expect(screen.queryByTestId('opencode-provider-select')).not.toBeInTheDocument();
    unmount();

    const opencodeAgent = makeAgent({
      id: 'opencode',
      name: 'OpenCode',
      description: 'OpenCode agent',
    });
    renderCard(opencodeAgent, null, makeSettings('opencode'));
    expect(screen.getByTestId('opencode-provider-select')).toBeInTheDocument();
  });
});
