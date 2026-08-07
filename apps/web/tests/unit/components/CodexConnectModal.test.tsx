import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createAgentCredentialSetupSession: vi.fn(),
  getAgentCredentialSetupSession: vi.fn(),
  cancelAgentCredentialSetupSession: vi.fn(),
  getAgentCredentialSetupConfig: vi.fn(),
  submitAgentCredentialSetupVerificationCode: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createAgentCredentialSetupSession: h.createAgentCredentialSetupSession,
  getAgentCredentialSetupSession: h.getAgentCredentialSetupSession,
  cancelAgentCredentialSetupSession: h.cancelAgentCredentialSetupSession,
  getAgentCredentialSetupConfig: h.getAgentCredentialSetupConfig,
  submitAgentCredentialSetupVerificationCode: h.submitAgentCredentialSetupVerificationCode,
}));

import {
  AgentCredentialConnectModal,
  CodexConnectModal,
} from '../../../src/components/CodexConnectModal';
import {
  AgentCredentialConnectTrigger,
  CodexConnectTrigger,
} from '../../../src/components/CodexConnectTrigger';
import type { AgentCredentialSetupSession, AgentCredentialSetupStatus } from '../../../src/lib/api';

const SESSION_ID = 'sess_setup_01';
const USER_CODE = 'ABCD-EFGH';
const OPENAI_VERIFICATION_URL = 'https://auth.openai.com/device';
const CLAUDE_VERIFICATION_URL = 'https://claude.ai/oauth/device';
const CLAUDE_VERIFICATION_CODE = 'abc123#state456';

function makeSession(
  status: AgentCredentialSetupStatus,
  overrides: Partial<AgentCredentialSetupSession> = {}
): AgentCredentialSetupSession {
  return {
    id: SESSION_ID,
    status,
    agentType: 'openai-codex',
    expiresAt: '2026-07-24T00:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('AgentCredentialConnectModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createAgentCredentialSetupSession.mockReset();
    h.getAgentCredentialSetupSession.mockReset();
    h.cancelAgentCredentialSetupSession.mockReset();
    h.getAgentCredentialSetupConfig.mockReset();
    h.submitAgentCredentialSetupVerificationCode.mockReset();
    vi.stubEnv('VITE_CODEX_SETUP_POLL_MS', '20');
    vi.stubEnv('VITE_CODEX_SETUP_SUCCESS_CLOSE_MS', '10');
    h.cancelAgentCredentialSetupSession.mockResolvedValue({ id: SESSION_ID, status: 'cancelled' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('promotes the Codex device URL and code into native open and copy actions', async () => {
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('provisioning'),
    });
    h.getAgentCredentialSetupSession.mockResolvedValue(
      makeSession('waiting_for_user', {
        verificationUrl: OPENAI_VERIFICATION_URL,
        userCode: USER_CODE,
      })
    );

    render(<CodexConnectModal isOpen onClose={vi.fn()} />);

    const openLink = await screen.findByRole('link', { name: /open openai sign-in/i });
    expect(h.createAgentCredentialSetupSession).toHaveBeenCalledWith('openai-codex');
    expect(openLink).toHaveAttribute('href', OPENAI_VERIFICATION_URL);
    expect(screen.getByText(USER_CODE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /copy code/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(USER_CODE));
    await screen.findByRole('button', { name: /copied/i });
  });

  it('promotes the Claude auth URL without requiring a terminal or one-time code', async () => {
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('provisioning', { agentType: 'claude-code' }),
    });
    h.getAgentCredentialSetupSession.mockResolvedValue(
      makeSession('waiting_for_user', {
        agentType: 'claude-code',
        verificationUrl: CLAUDE_VERIFICATION_URL,
        userCode: null,
      })
    );

    render(<AgentCredentialConnectModal agentType="claude-code" isOpen onClose={vi.fn()} />);

    const openLink = await screen.findByRole('link', { name: /open claude sign-in/i });
    expect(h.createAgentCredentialSetupSession).toHaveBeenCalledWith('claude-code');
    expect(openLink).toHaveAttribute('href', CLAUDE_VERIFICATION_URL);
    expect(screen.queryByRole('button', { name: /copy code/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('codex-terminal')).not.toBeInTheDocument();
  });

  it('lets Claude users paste the browser verification code and complete setup', async () => {
    const onConnected = vi.fn();
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('provisioning', { agentType: 'claude-code' }),
    });
    h.getAgentCredentialSetupSession.mockResolvedValue(
      makeSession('waiting_for_user', {
        agentType: 'claude-code',
        verificationUrl: CLAUDE_VERIFICATION_URL,
        userCode: null,
      })
    );
    h.submitAgentCredentialSetupVerificationCode.mockResolvedValue(
      makeSession('completed', { agentType: 'claude-code' })
    );

    render(
      <AgentCredentialConnectModal
        agentType="claude-code"
        isOpen
        onClose={vi.fn()}
        onConnected={onConnected}
      />
    );

    await screen.findByRole('link', { name: /open claude sign-in/i });
    const tokenInput = screen.getByLabelText(/paste the code claude shows you/i);
    fireEvent.change(tokenInput, {
      target: {
        value: ` ${CLAUDE_VERIFICATION_CODE}
`,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue sign-in/i }));

    await waitFor(() =>
      expect(h.submitAgentCredentialSetupVerificationCode).toHaveBeenCalledWith(
        SESSION_ID,
        CLAUDE_VERIFICATION_CODE
      )
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Claude Code connected/)).toBeInTheDocument();
  });

  it('blocks a Claude code paste missing its #state half before any server round-trip', async () => {
    // Claude's browser page shows `<code>#<state>`; copying only the code half
    // is guaranteed to fail inside the CLI, so the modal must catch it with
    // actionable guidance instead of burning the setup session.
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('provisioning', { agentType: 'claude-code' }),
    });
    h.getAgentCredentialSetupSession.mockResolvedValue(
      makeSession('waiting_for_user', {
        agentType: 'claude-code',
        verificationUrl: CLAUDE_VERIFICATION_URL,
        userCode: null,
      })
    );

    render(
      <AgentCredentialConnectModal
        agentType="claude-code"
        isOpen
        onClose={vi.fn()}
        onConnected={vi.fn()}
      />
    );

    await screen.findByRole('link', { name: /open claude sign-in/i });
    const tokenInput = screen.getByLabelText(/paste the code claude shows you/i);
    fireEvent.change(tokenInput, { target: { value: 'abc123-no-state-half' } });
    fireEvent.click(screen.getByRole('button', { name: /continue sign-in/i }));

    expect(
      await screen.findByText(/copy the entire code claude shows/i)
    ).toBeInTheDocument();
    expect(h.submitAgentCredentialSetupVerificationCode).not.toHaveBeenCalled();
  });

  it('reports completion without exposing a terminal surface', async () => {
    const onConnected = vi.fn();
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('waiting_for_user', {
        verificationUrl: OPENAI_VERIFICATION_URL,
        userCode: USER_CODE,
      }),
    });
    h.getAgentCredentialSetupSession.mockResolvedValue(makeSession('completed'));

    render(<CodexConnectModal isOpen onClose={vi.fn()} onConnected={onConnected} />);
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    await screen.findByText(/Codex connected/);
    expect(screen.queryByTestId('codex-terminal')).not.toBeInTheDocument();
  });

  it('keeps an active server session running on passive close but cancels explicitly', async () => {
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('waiting_for_user', {
        verificationUrl: OPENAI_VERIFICATION_URL,
        userCode: USER_CODE,
      }),
    });
    h.getAgentCredentialSetupSession.mockResolvedValue(
      makeSession('waiting_for_user', {
        verificationUrl: OPENAI_VERIFICATION_URL,
        userCode: USER_CODE,
      })
    );
    const onClose = vi.fn();
    const view = render(<CodexConnectModal isOpen onClose={onClose} />);
    await screen.findByRole('link', { name: /open openai sign-in/i });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(h.cancelAgentCredentialSetupSession).not.toHaveBeenCalled();

    render(<CodexConnectModal isOpen onClose={vi.fn()} />);
    await screen.findByRole('link', { name: /open openai sign-in/i });
    expect(screen.getByText(USER_CODE)).toBeInTheDocument();
    expect(h.createAgentCredentialSetupSession).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() =>
      expect(h.cancelAgentCredentialSetupSession).toHaveBeenCalledWith(SESSION_ID)
    );
  });

  it('surfaces clipboard failure while leaving the code selectable', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('waiting_for_user', {
        verificationUrl: OPENAI_VERIFICATION_URL,
        userCode: USER_CODE,
      }),
    });
    h.getAgentCredentialSetupSession.mockResolvedValue(
      makeSession('waiting_for_user', {
        verificationUrl: OPENAI_VERIFICATION_URL,
        userCode: USER_CODE,
      })
    );
    render(<CodexConnectModal isOpen onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /copy code/i }));

    await screen.findByText(/press and hold the code to copy it/i);
    expect(screen.getByText(USER_CODE)).toHaveClass('select-all');
  });

  it('serializes polling and reports completion once', async () => {
    let resolvePoll: ((session: AgentCredentialSetupSession) => void) | undefined;
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('provisioning'),
    });
    h.getAgentCredentialSetupSession.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      })
    );
    const onConnected = vi.fn();
    render(<CodexConnectModal isOpen onClose={vi.fn()} onConnected={onConnected} />);
    await waitFor(() => expect(h.getAgentCredentialSetupSession).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(h.getAgentCredentialSetupSession).toHaveBeenCalledOnce();

    resolvePoll?.(makeSession('completed'));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it('shows the active-session conflict with retry', async () => {
    h.createAgentCredentialSetupSession.mockResolvedValue({
      kind: 'active_exists',
      message: 'A setup session is already in progress',
    });
    render(<CodexConnectModal isOpen onClose={vi.fn()} />);
    await screen.findByText(/already in progress/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps guided setup user-scoped and visible only when runtime bindings support the agent', async () => {
    h.getAgentCredentialSetupConfig.mockResolvedValue({
      enabled: true,
      agentType: 'openai-codex',
      agentTypes: ['openai-codex', 'claude-code'],
    });
    render(<CodexConnectTrigger scope="project" onConnected={vi.fn()} />);
    await waitFor(() => expect(h.getAgentCredentialSetupConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /connect with codex/i })).toBeNull();

    render(<AgentCredentialConnectTrigger agentType="claude-code" scope="user" />);
    await screen.findByRole('button', { name: /connect with claude code/i });
  });
});
