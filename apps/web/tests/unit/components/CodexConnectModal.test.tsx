import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createCodexSetupSession: vi.fn(),
  getCodexSetupSession: vi.fn(),
  cancelCodexSetupSession: vi.fn(),
  getCodexSetupConfig: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createCodexSetupSession: h.createCodexSetupSession,
  getCodexSetupSession: h.getCodexSetupSession,
  cancelCodexSetupSession: h.cancelCodexSetupSession,
  getCodexSetupConfig: h.getCodexSetupConfig,
}));

import { CodexConnectModal } from '../../../src/components/CodexConnectModal';
import { CodexConnectTrigger } from '../../../src/components/CodexConnectTrigger';
import type { CodexSetupSession, CodexSetupStatus } from '../../../src/lib/api';

const SESSION_ID = 'sess_codex_01';
const USER_CODE = 'ABCD-EFGH';
const VERIFICATION_URL = 'https://auth.openai.com/device';

function makeSession(
  status: CodexSetupStatus,
  overrides: Partial<CodexSetupSession> = {}
): CodexSetupSession {
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

describe('CodexConnectModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_CODEX_SETUP_POLL_MS', '20');
    vi.stubEnv('VITE_CODEX_SETUP_SUCCESS_CLOSE_MS', '10');
    h.cancelCodexSetupSession.mockResolvedValue({ id: SESSION_ID, status: 'cancelled' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('promotes the device URL and code into native open and copy actions', async () => {
    h.createCodexSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('provisioning'),
    });
    h.getCodexSetupSession.mockResolvedValue(
      makeSession('waiting_for_user', {
        verificationUrl: VERIFICATION_URL,
        userCode: USER_CODE,
      })
    );

    render(<CodexConnectModal isOpen onClose={vi.fn()} />);

    const openLink = await screen.findByRole('link', { name: /open openai sign-in/i });
    expect(openLink).toHaveAttribute('href', VERIFICATION_URL);
    expect(screen.getByText(USER_CODE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /copy code/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(USER_CODE));
    await screen.findByRole('button', { name: /copied/i });
  });

  it('reports completion without exposing a terminal surface', async () => {
    const onConnected = vi.fn();
    h.createCodexSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('waiting_for_user', {
        verificationUrl: VERIFICATION_URL,
        userCode: USER_CODE,
      }),
    });
    h.getCodexSetupSession.mockResolvedValue(makeSession('completed'));

    render(<CodexConnectModal isOpen onClose={vi.fn()} onConnected={onConnected} />);
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    await screen.findByText(/Codex connected/);
    expect(screen.queryByTestId('codex-terminal')).not.toBeInTheDocument();
  });

  it('shows the active-session conflict with retry', async () => {
    h.createCodexSetupSession.mockResolvedValue({
      kind: 'active_exists',
      message: 'A setup session is already in progress',
    });
    render(<CodexConnectModal isOpen onClose={vi.fn()} />);
    await screen.findByText(/already in progress/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps guided setup user-scoped and visible when runtime bindings enable it', async () => {
    h.getCodexSetupConfig.mockResolvedValue({ enabled: true, agentType: 'openai-codex' });
    render(<CodexConnectTrigger scope="project" onConnected={vi.fn()} />);
    await waitFor(() => expect(h.getCodexSetupConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /connect with codex/i })).toBeNull();
  });
});
