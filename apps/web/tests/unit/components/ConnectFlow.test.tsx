import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveAgentCredential: vi.fn(),
  saveProjectAgentCredential: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  saveAgentCredential: mocks.saveAgentCredential,
  saveProjectAgentCredential: mocks.saveProjectAgentCredential,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: mocks.success, error: vi.fn(), info: vi.fn() }),
}));

import { ConnectFlow } from '../../../src/components/ConnectFlow';

function renderFlow(props: Partial<React.ComponentProps<typeof ConnectFlow>> = {}) {
  return render(<ConnectFlow {...props} />);
}

describe('ConnectFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveAgentCredential.mockResolvedValue({});
    mocks.saveProjectAgentCredential.mockResolvedValue({});
  });

  it('renders agent selection cards from AGENT_CATALOG', () => {
    renderFlow();
    // AGENT_CATALOG has at least claude-code
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('shows credential form after selecting an agent', () => {
    renderFlow();

    fireEvent.click(screen.getByText('Claude Code'));

    expect(screen.getByLabelText(/API Key/i)).toBeInTheDocument();
    expect(screen.getByText('API Key', { selector: 'button' })).toBeInTheDocument();
  });

  it('pre-selects agent when initialAgentId is provided', () => {
    renderFlow({ initialAgentId: 'claude-code' });

    // Credential form should be visible immediately
    expect(screen.getByLabelText(/API Key/i)).toBeInTheDocument();
  });

  it('save button is disabled when credential is empty', () => {
    renderFlow({ initialAgentId: 'claude-code' });

    const saveButton = screen.getByRole('button', { name: /Connect$/i });
    expect(saveButton).toBeDisabled();
  });

  it('calls saveAgentCredential with correct payload on save', async () => {
    const onConnected = vi.fn();
    renderFlow({ initialAgentId: 'claude-code', onConnected });

    const input = screen.getByLabelText(/API Key/i);
    fireEvent.change(input, { target: { value: 'sk-ant-test-key' } });

    const saveButton = screen.getByRole('button', { name: /Connect$/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mocks.saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-test-key',
      });
    });

    expect(onConnected).toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalled();
  });

  it('calls saveProjectAgentCredential when projectId is set', async () => {
    const onConnected = vi.fn();
    renderFlow({ projectId: 'proj-1', initialAgentId: 'claude-code', onConnected });

    const input = screen.getByLabelText(/API Key/i);
    fireEvent.change(input, { target: { value: 'sk-ant-test-key' } });

    const saveButton = screen.getByRole('button', { name: /Save override/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mocks.saveProjectAgentCredential).toHaveBeenCalledWith('proj-1', {
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-test-key',
      });
    });

    expect(onConnected).toHaveBeenCalled();
  });

  it('uses a multiline Codex auth.json field and saves it as oauth-token', async () => {
    const authJson = '{"tokens":{"access_token":"codex-access"}}';
    renderFlow({
      initialAgentId: 'openai-codex',
      initialAuthMethod: 'oauth-token',
      mode: 'replace',
    });

    expect(screen.getByRole('button', { name: 'Codex auth.json' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const textarea = screen.getByLabelText('Codex auth.json');
    fireEvent.change(textarea, { target: { value: authJson } });

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

    await waitFor(() => {
      expect(mocks.saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
        credential: authJson,
      });
    });
  });

  it('shows error alert on save failure', async () => {
    mocks.saveAgentCredential.mockRejectedValue(new Error('Invalid key'));
    renderFlow({ initialAgentId: 'claude-code' });

    const input = screen.getByLabelText(/API Key/i);
    fireEvent.change(input, { target: { value: 'bad-key' } });

    fireEvent.click(screen.getByRole('button', { name: /Connect$/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid key')).toBeInTheDocument();
    });
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    renderFlow({ initialAgentId: 'claude-code', onCancel });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
  });

  it('switching agent clears credential input', () => {
    renderFlow();

    // Select first agent and type a key
    fireEvent.click(screen.getByText('Claude Code'));
    const input = screen.getByLabelText(/API Key/i);
    fireEvent.change(input, { target: { value: 'some-key' } });
    expect(input).toHaveValue('some-key');

    // Select a different agent (Codex if available, otherwise any other)
    const buttons = screen.getAllByRole('button', { pressed: false });
    const otherAgent = buttons.find((b) => b.textContent?.includes('Codex'));
    if (otherAgent) {
      fireEvent.click(otherAgent);
      const newInput = screen.getByLabelText(/API Key/i);
      expect(newInput).toHaveValue('');
    }
  });
});
