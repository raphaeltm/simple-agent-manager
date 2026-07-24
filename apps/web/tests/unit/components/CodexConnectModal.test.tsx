/**
 * Behavioral tests for the guided "Connect with Codex" modal.
 *
 * Mocks the setup-session API client and the xterm / Cloudflare Sandbox addon
 * (jsdom has no real terminal), then drives the modal through its lifecycle:
 * create -> poll (Preparing -> Waiting for sign-in) -> terminal-token fetch ->
 * auto-run login on connect -> completed (onConnected + success). Also covers
 * the 409 "already in progress" branch.
 *
 * NOTE: lives under tests/ (not next to the component) because the web vitest
 * config only includes `tests/**` — a test under src/ would never run.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTerminal {
  cols: number;
  rows: number;
  loadAddon: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeAddon {
  options: { onStateChange?: (state: string, err?: Error) => void };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  createCodexSetupSession: vi.fn(),
  getCodexSetupSession: vi.fn(),
  getCodexSetupTerminalToken: vi.fn(),
  cancelCodexSetupSession: vi.fn(),
  getCodexSetupConfig: vi.fn(),
  terminalInstances: [] as FakeTerminal[],
  addonInstances: [] as FakeAddon[],
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createCodexSetupSession: h.createCodexSetupSession,
  getCodexSetupSession: h.getCodexSetupSession,
  getCodexSetupTerminalToken: h.getCodexSetupTerminalToken,
  cancelCodexSetupSession: h.cancelCodexSetupSession,
  getCodexSetupConfig: h.getCodexSetupConfig,
}));

vi.mock('@xterm/xterm', () => ({
  // Regular function (not arrow) so it works when invoked with `new`.
  Terminal: vi.fn().mockImplementation(function (): FakeTerminal {
    const inst: FakeTerminal = {
      cols: 80,
      rows: 24,
      loadAddon: vi.fn(),
      open: vi.fn(),
      paste: vi.fn(),
      input: vi.fn(),
      dispose: vi.fn(),
    };
    h.terminalInstances.push(inst);
    return inst;
  }),
}));

vi.mock('@cloudflare/sandbox/xterm', () => ({
  SandboxAddon: vi.fn().mockImplementation(function (options: FakeAddon['options']): FakeAddon {
    const inst: FakeAddon = {
      options,
      connect: vi.fn(),
      disconnect: vi.fn(),
      dispose: vi.fn(),
    };
    h.addonInstances.push(inst);
    return inst;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function () {
    return { fit: vi.fn() };
  }),
}));

// jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { CodexConnectModal } from '../../../src/components/CodexConnectModal';
import { CodexConnectTrigger } from '../../../src/components/CodexConnectTrigger';
import type { CodexSetupSession, CodexSetupStatus } from '../../../src/lib/api';

const SESSION_ID = 'sess_codex_01';
const LOGIN_COMMAND = `CODEX_HOME=/tmp/codex-setup-${SESSION_ID} codex login --device-auth`;

function makeSession(
  status: CodexSetupStatus,
  overrides: Partial<CodexSetupSession> = {},
): CodexSetupSession {
  return {
    id: SESSION_ID,
    status,
    agentType: 'openai-codex',
    expiresAt: '2026-07-24T00:00:00.000Z',
    loginCommand: LOGIN_COMMAND,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('CodexConnectModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.terminalInstances.length = 0;
    h.addonInstances.length = 0;
    // Shorten the poll + auto-close loops so real-timer assertions stay fast.
    vi.stubEnv('VITE_CODEX_SETUP_POLL_MS', '20');
    vi.stubEnv('VITE_CODEX_SETUP_SUCCESS_CLOSE_MS', '10');
    h.getCodexSetupTerminalToken.mockResolvedValue({ token: 'ws-token-123' });
    h.cancelCodexSetupSession.mockResolvedValue({ id: SESSION_ID, status: 'cancelled' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates a session, advances status, fetches a terminal token, auto-runs login, and reports completion', async () => {
    const onConnected = vi.fn();
    const onClose = vi.fn();

    h.createCodexSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('provisioning'),
    });
    // poll 1: still preparing; poll 2: waiting for sign-in; poll 3+: completed.
    h.getCodexSetupSession
      .mockResolvedValueOnce(makeSession('provisioning'))
      .mockResolvedValueOnce(makeSession('waiting_for_user'))
      .mockResolvedValue(makeSession('completed'));

    render(<CodexConnectModal isOpen onClose={onClose} onConnected={onConnected} />);

    // 1. create is called on open.
    await waitFor(() => expect(h.createCodexSetupSession).toHaveBeenCalledTimes(1));

    // 2. status advances: Preparing terminal -> Waiting for sign-in.
    await screen.findByText(/Preparing terminal/);
    await screen.findByText(/Waiting for sign-in/);

    // 3. a terminal token is fetched once the session is waiting_for_user.
    await waitFor(() =>
      expect(h.getCodexSetupTerminalToken).toHaveBeenCalledWith(SESSION_ID),
    );

    // 4. on socket connect, the login command auto-runs exactly once.
    await waitFor(() => expect(h.addonInstances.length).toBeGreaterThan(0));
    h.addonInstances[0].options.onStateChange?.('connected');
    h.addonInstances[0].options.onStateChange?.('connected'); // guarded — still once
    // input() (NOT paste()) so the trailing \r executes the command — paste()
    // would be bracketed and the command would never run.
    expect(h.terminalInstances[0].input).toHaveBeenCalledTimes(1);
    expect(h.terminalInstances[0].input).toHaveBeenCalledWith(`${LOGIN_COMMAND}\r`);
    expect(h.terminalInstances[0].paste).not.toHaveBeenCalled();

    // 5. on completed: onConnected fires and a success state shows.
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    await screen.findByText(/Codex connected/);
  });

  it('shows the "already in progress" message when create returns 409', async () => {
    const onConnected = vi.fn();
    const onClose = vi.fn();

    h.createCodexSetupSession.mockResolvedValue({
      kind: 'active_exists',
      message: 'A setup session is already in progress',
    });

    render(<CodexConnectModal isOpen onClose={onClose} onConnected={onConnected} />);

    await waitFor(() => expect(h.createCodexSetupSession).toHaveBeenCalledTimes(1));
    await screen.findByText(/already in progress/);
    // Retry affordance is offered; the guided flow never fetched a terminal token.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(h.getCodexSetupTerminalToken).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('surfaces the no-capacity (202) message with a retry affordance', async () => {
    h.createCodexSetupSession.mockResolvedValue({
      kind: 'no_capacity',
      message: 'All guided setup slots are in use. Please try again in a minute.',
    });

    render(<CodexConnectModal isOpen onClose={vi.fn()} onConnected={vi.fn()} />);

    await screen.findByText(/All guided setup slots are in use/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('CodexConnectTrigger keeps the success state visible on completion (no force-close)', async () => {
    // Reproduces the CRITICAL bug: the trigger's onConnected used to call
    // setModalOpen(false), unmounting the modal before "Codex connected" rendered.
    vi.stubEnv('VITE_CODEX_SETUP_SUCCESS_CLOSE_MS', '5000'); // keep success on screen
    h.getCodexSetupConfig.mockResolvedValue({ enabled: true, agentType: 'openai-codex' });
    h.createCodexSetupSession.mockResolvedValue({
      kind: 'created',
      session: makeSession('waiting_for_user'),
    });
    h.getCodexSetupSession.mockResolvedValue(makeSession('completed'));
    const onConnected = vi.fn();

    render(<CodexConnectTrigger scope="user" onConnected={onConnected} />);

    const openBtn = await screen.findByRole('button', { name: /connect with codex/i });
    fireEvent.click(openBtn);

    await waitFor(() => expect(h.createCodexSetupSession).toHaveBeenCalledTimes(1));
    // On completion: parent refresh fires AND the success state renders (the modal
    // is NOT force-closed by the trigger before the user sees confirmation).
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    await screen.findByText(/Codex connected/);
  });

  it('CodexConnectTrigger renders nothing in a project-scoped context', async () => {
    h.getCodexSetupConfig.mockResolvedValue({ enabled: true, agentType: 'openai-codex' });
    render(<CodexConnectTrigger scope="project" onConnected={vi.fn()} />);
    // Even with the feature enabled, project scope hides the guided button (v1 is
    // user-scoped only) — the manual auth.json paste remains the path there.
    await waitFor(() => expect(h.getCodexSetupConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /connect with codex/i })).toBeNull();
  });
});
