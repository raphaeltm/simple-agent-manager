import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveAgentCredential: vi.fn(),
  saveProjectAgentCredential: vi.fn(),
  saveAgentSettings: vi.fn(),
  getAgentCredentialSetupConfig: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  saveAgentCredential: mocks.saveAgentCredential,
  saveProjectAgentCredential: mocks.saveProjectAgentCredential,
  saveAgentSettings: mocks.saveAgentSettings,
  getAgentCredentialSetupConfig: mocks.getAgentCredentialSetupConfig,
}));

vi.mock('../../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: mocks.success, error: vi.fn(), info: vi.fn() }),
}));

import { AgentConnectForm } from '../../../../src/components/accounts/AgentConnectForm';

type Props = React.ComponentProps<typeof AgentConnectForm>;

function renderForm(props: Partial<Props> = {}) {
  return render(<AgentConnectForm agentId="claude-code" {...props} />);
}

function chooseApiKey() {
  fireEvent.click(screen.getByRole('radio', { name: /API key/i }));
}

describe('AgentConnectForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveAgentCredential.mockResolvedValue({});
    mocks.saveProjectAgentCredential.mockResolvedValue({});
    mocks.saveAgentSettings.mockResolvedValue({});
    mocks.getAgentCredentialSetupConfig.mockRejectedValue(new Error('gate unavailable'));
  });

  it('offers the subscription first and selects it by default for Claude Code', () => {
    renderForm();

    const subscription = screen.getByRole('radio', { name: /Claude subscription/i });
    const apiKey = screen.getByRole('radio', { name: /API key/i });
    expect(subscription).toHaveAttribute('aria-checked', 'true');
    expect(apiKey).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Setup token')).toBeInTheDocument();
  });

  it('names the API key source after the provider', () => {
    renderForm();

    expect(screen.getByText('Pay-as-you-go key from your Anthropic console.')).toBeVisible();
  });

  it('honours an explicit initial method', () => {
    renderForm({ initialAuthMethod: 'api-key' });

    expect(screen.getByRole('radio', { name: /API key/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
  });

  it('shows a single OpenCode Zen or Go key method with no method picker', () => {
    renderForm({ agentId: 'opencode' });

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByLabelText('OpenCode API key')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'OpenCode' })).toHaveAttribute(
      'href',
      'https://opencode.ai/auth'
    );
    expect(screen.getByPlaceholderText('OPENCODE_API_KEY')).toBeInTheDocument();
  });

  it('switching method clears the typed credential', () => {
    renderForm();

    const token = screen.getByLabelText('Setup token');
    fireEvent.change(token, { target: { value: 'sk-ant-oat-typed' } });
    expect(token).toHaveValue('sk-ant-oat-typed');

    chooseApiKey();
    expect(screen.getByLabelText('API key')).toHaveValue('');
  });

  it('disables Connect while the credential is empty', () => {
    renderForm();

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('saves a user-scoped API key through the legacy save path', async () => {
    const onConnected = vi.fn();
    renderForm({ onConnected });

    chooseApiKey();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-test-key',
      });
    });
    expect(mocks.saveProjectAgentCredential).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith('Claude Code connected');
  });

  it('saves a subscription token as oauth-token', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Setup token'), {
      target: { value: 'sk-ant-oat-abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        credential: 'sk-ant-oat-abc',
      });
    });
  });

  it('writes a project-scoped account when projectId is set', async () => {
    const onConnected = vi.fn();
    renderForm({ projectId: 'proj-1', onConnected });

    chooseApiKey();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use for this project' }));

    await waitFor(() => {
      expect(mocks.saveProjectAgentCredential).toHaveBeenCalledWith('proj-1', {
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-test-key',
      });
    });
    expect(mocks.saveAgentCredential).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalled();
  });

  it('uses a multiline auth.json field for ChatGPT sign-in and saves it as oauth-token', async () => {
    const authJson = '{"tokens":{"access_token":"codex-access"}}';
    renderForm({ agentId: 'openai-codex' });

    expect(screen.getByRole('radio', { name: /ChatGPT sign-in/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    const textarea = screen.getByLabelText('Codex auth.json');
    expect(textarea.tagName).toBe('TEXTAREA');
    fireEvent.change(textarea, { target: { value: authJson } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
        credential: authJson,
      });
    });
  });

  it('shows the guided sign-in only when the setup gate allows it', async () => {
    mocks.getAgentCredentialSetupConfig.mockResolvedValue({
      enabled: true,
      agentType: 'claude-code',
      agentTypes: ['claude-code'],
    });
    renderForm();

    expect(
      await screen.findByRole('button', { name: 'Connect with Claude Code' })
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('Or paste a setup token manually')).toBeInTheDocument();
  });

  it('hides the guided sign-in for a project-scoped account', async () => {
    mocks.getAgentCredentialSetupConfig.mockResolvedValue({
      enabled: true,
      agentType: 'claude-code',
      agentTypes: ['claude-code'],
    });
    renderForm({ projectId: 'proj-1' });

    await waitFor(() => expect(mocks.getAgentCredentialSetupConfig).toHaveBeenCalled());
    expect(screen.getByLabelText('Setup token')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect with Claude Code' })).toBeNull();
  });

  it('shows the save error and does not report success', async () => {
    mocks.saveAgentCredential.mockRejectedValue(new Error('Invalid key'));
    const onConnected = vi.fn();
    renderForm({ onConnected });

    chooseApiKey();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Invalid key')).toBeInTheDocument();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('defaults the OpenCode provider to opencode-zen and saves the selected Go provider', async () => {
    const onConnected = vi.fn();
    renderForm({ agentId: 'opencode', onConnected });

    const providerSelect = screen.getByLabelText<HTMLSelectElement>('OpenCode provider');
    expect(providerSelect.value).toBe('opencode-zen');
    fireEvent.change(providerSelect, { target: { value: 'opencode-go' } });

    fireEvent.change(screen.getByLabelText('OpenCode API key'), {
      target: { value: 'opencode-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'opencode',
        credentialKind: 'api-key',
        credential: 'opencode-key',
      });
    });
    expect(mocks.saveAgentSettings).toHaveBeenCalledWith('opencode', {
      opencodeProvider: 'opencode-go',
      opencodeBaseUrl: null,
      model: null,
    });
    expect(onConnected).toHaveBeenCalled();
  });

  it('saves a model string alongside the OpenCode provider', async () => {
    renderForm({ agentId: 'opencode' });

    fireEvent.change(screen.getByLabelText('OpenCode API key'), {
      target: { value: 'opencode-key' },
    });
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'opencode/claude-sonnet-4-6' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.saveAgentSettings).toHaveBeenCalledWith('opencode', {
        opencodeProvider: 'opencode-zen',
        opencodeBaseUrl: null,
        model: 'opencode/claude-sonnet-4-6',
      });
    });
  });

  it('passes a base URL only for the custom OpenCode provider', async () => {
    renderForm({ agentId: 'opencode' });

    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('OpenCode provider'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://llm.example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('OpenCode API key'), {
      target: { value: 'opencode-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.saveAgentSettings).toHaveBeenCalledWith('opencode', {
        opencodeProvider: 'custom',
        opencodeBaseUrl: 'https://llm.example.com/v1',
        model: null,
      });
    });
  });

  it('does not save OpenCode provider settings when the credential save fails', async () => {
    mocks.saveAgentCredential.mockRejectedValue(new Error('Invalid key'));
    renderForm({ agentId: 'opencode' });

    fireEvent.change(screen.getByLabelText('OpenCode API key'), {
      target: { value: 'opencode-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Invalid key')).toBeInTheDocument();
    // Credential-first ordering: no half-applied provider settings.
    expect(mocks.saveAgentSettings).not.toHaveBeenCalled();
  });

  it('does not offer OpenCode provider settings for a project-scoped account', () => {
    renderForm({ agentId: 'opencode', projectId: 'proj-1' });

    expect(screen.getByLabelText('OpenCode API key')).toBeInTheDocument();
    expect(screen.queryByLabelText('OpenCode provider')).not.toBeInTheDocument();
  });

  it('surfaces an error when saving OpenCode provider settings fails', async () => {
    mocks.saveAgentSettings.mockRejectedValue(new Error('settings rejected'));
    renderForm({ agentId: 'opencode' });

    fireEvent.change(screen.getByLabelText('OpenCode API key'), {
      target: { value: 'opencode-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('settings rejected')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    renderForm({ onCancel });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders an error for an agent this installation does not know', () => {
    renderForm({ agentId: 'not-an-agent' });

    expect(screen.getByText('This agent is not available on this installation.')).toBeVisible();
  });
});
