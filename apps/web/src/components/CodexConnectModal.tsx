/**
 * "Connect with Codex" guided-setup modal.
 *
 * Runs `codex login --device-auth` inside a Cloudflare Sandbox terminal so the
 * user can sign in to their ChatGPT subscription without pasting auth.json:
 *
 *   1. On open: POST a setup session (handles 202 no-capacity + 409 already-active).
 *   2. Poll GET /:id every ~2s, surfacing lifecycle status as a subtle status line.
 *   3. On `waiting_for_user`: mint a terminal token, mount xterm wired to the
 *      SandboxAddon, and auto-run the login command once the socket connects.
 *   4. On `completed`: fire onConnected() (parent refreshes credentials — no page
 *      reload, rule 16) and self-close shortly after.
 *   5. On close/unmount/cancel: best-effort cancel the session and dispose the
 *      terminal + socket + poll interval (no leaks).
 *
 * Follows rule 48 (stale-while-revalidate): polling never replaces already-visible
 * content with a full-screen spinner; the status line updates in place.
 */
import '@xterm/xterm/css/xterm.css';

import { SandboxAddon } from '@cloudflare/sandbox/xterm';
import { Alert, Button, Dialog } from '@simple-agent-manager/ui';
import { type ITheme, Terminal } from '@xterm/xterm';
import { useEffect, useId, useRef, useState } from 'react';

import {
  buildCodexSetupWsUrl,
  cancelCodexSetupSession,
  type CodexSetupSession,
  type CodexSetupStatus,
  createCodexSetupSession,
  getCodexSetupSession,
  getCodexSetupTerminalToken,
  isTerminalCodexSetupStatus,
} from '../lib/api';

interface CodexConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the credential is captured + saved so the parent can refresh. */
  onConnected?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SUCCESS_CLOSE_DELAY_MS = 1500;

/** Monospace stack matching the app's terminal surfaces. */
const TERMINAL_FONT_FAMILY = 'JetBrains Mono, Menlo, Monaco, monospace';

/** Dark xterm theme (Tokyo Night) consistent with the app's terminal styling. */
const TERMINAL_THEME: ITheme = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  selectionBackground: '#33467c',
  black: '#32344a',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#ad8ee6',
  cyan: '#449dab',
  white: '#787c99',
  brightBlack: '#444b6a',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#acb0d0',
};

/** Read lazily so tests can shorten the loop via `vi.stubEnv`. */
function getPollIntervalMs(): number {
  return Number(import.meta.env.VITE_CODEX_SETUP_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS);
}
function getSuccessCloseDelayMs(): number {
  return Number(import.meta.env.VITE_CODEX_SETUP_SUCCESS_CLOSE_MS ?? DEFAULT_SUCCESS_CLOSE_DELAY_MS);
}

type CreatePhase = 'creating' | 'created' | 'blocked' | 'error';

/** User-facing label for each lifecycle status. */
function statusLabel(status: CodexSetupStatus): string {
  switch (status) {
    case 'creating':
    case 'admitting':
    case 'provisioning':
      return 'Preparing terminal…';
    case 'waiting_for_user':
    case 'capturing':
      return 'Waiting for sign-in';
    case 'saving':
      return 'Saving…';
    case 'completed':
      return 'Connected';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Session expired';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Terminal statuses that are failures (as opposed to `completed`). */
function isFailureStatus(status: CodexSetupStatus): boolean {
  return status === 'failed' || status === 'expired' || status === 'cancelled';
}

export function CodexConnectModal({ isOpen, onClose, onConnected }: CodexConnectModalProps) {
  const titleId = useId();

  const [createPhase, setCreatePhase] = useState<CreatePhase>('creating');
  const [session, setSession] = useState<CodexSetupSession | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  // Bumped to re-run the controller effect for a clean retry.
  const [retryNonce, setRetryNonce] = useState(0);

  // Latest callbacks — accessed via refs so the controller effect can depend
  // only on [isOpen, retryNonce] without going stale (rule 48 loop-safety).
  const onConnectedRef = useRef(onConnected);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onConnectedRef.current = onConnected;
    onCloseRef.current = onClose;
  });

  // Imperative terminal/session state.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const addonRef = useRef<SandboxAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalMountedRef = useRef(false);
  const autoRanRef = useRef(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    // Reset per-open state.
    setCreatePhase('creating');
    setSession(null);
    setBlockedMessage(null);
    setCreateError(null);
    setTerminalError(null);
    sessionIdRef.current = null;
    terminalMountedRef.current = false;
    autoRanRef.current = false;
    finishedRef.current = false;

    const disposeTerminal = () => {
      try {
        addonRef.current?.dispose();
      } catch {
        /* addon already disposed */
      }
      try {
        termRef.current?.dispose();
      } catch {
        /* terminal already disposed */
      }
      addonRef.current = null;
      termRef.current = null;
    };

    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const mountTerminal = async (active: CodexSetupSession) => {
      if (terminalMountedRef.current) return;
      terminalMountedRef.current = true;
      try {
        const { token } = await getCodexSetupTerminalToken(active.id);
        if (cancelled) return;
        const container = containerRef.current;
        if (!container) {
          // Container not committed yet — allow a later poll to retry.
          terminalMountedRef.current = false;
          return;
        }
        const term = new Terminal({
          theme: TERMINAL_THEME,
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize: 13,
          cursorBlink: true,
          scrollback: 2000,
        });
        const addon = new SandboxAddon({
          getWebSocketUrl: ({ sandboxId }) =>
            buildCodexSetupWsUrl(sandboxId, token, term.cols, term.rows),
          reconnect: false,
          onStateChange: (state) => {
            if (cancelled) return;
            if (state === 'connected' && !autoRanRef.current) {
              // Auto-run the device-auth login exactly once so the sign-in URL
              // + code appear for the user to complete in their browser.
              autoRanRef.current = true;
              term.paste(`${active.loginCommand}\r`);
            }
          },
        });
        termRef.current = term;
        addonRef.current = addon;
        term.loadAddon(addon);
        term.open(container);
        addon.connect({ sandboxId: active.id });
      } catch (err) {
        if (!cancelled) {
          setTerminalError(err instanceof Error ? err.message : 'Failed to open terminal');
        }
      }
    };

    const handleTerminal = (active: CodexSetupSession) => {
      stopPolling();
      finishedRef.current = true;
      if (active.status === 'completed') {
        onConnectedRef.current?.();
        closeTimerRef.current = setTimeout(() => {
          if (!cancelled) onCloseRef.current();
        }, getSuccessCloseDelayMs());
      }
    };

    const poll = async () => {
      const id = sessionIdRef.current;
      if (!id) return;
      try {
        const next = await getCodexSetupSession(id);
        if (cancelled) return;
        setSession(next);
        if (next.status === 'waiting_for_user') {
          void mountTerminal(next);
        }
        if (isTerminalCodexSetupStatus(next.status)) {
          handleTerminal(next);
        }
      } catch {
        // Transient poll failure — keep the last-known status visible and let
        // the next tick retry (stale-while-revalidate).
      }
    };

    const start = async () => {
      try {
        const result = await createCodexSetupSession();
        if (cancelled) return;
        if (result.kind === 'no_capacity' || result.kind === 'active_exists') {
          setCreatePhase('blocked');
          setBlockedMessage(result.message);
          return;
        }
        const active = result.session;
        sessionIdRef.current = active.id;
        setSession(active);
        setCreatePhase('created');
        if (isTerminalCodexSetupStatus(active.status)) {
          handleTerminal(active);
          return;
        }
        if (active.status === 'waiting_for_user') {
          void mountTerminal(active);
        }
        pollRef.current = setInterval(() => void poll(), getPollIntervalMs());
      } catch (err) {
        if (cancelled) return;
        setCreatePhase('error');
        setCreateError(err instanceof Error ? err.message : 'Failed to start guided setup');
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopPolling();
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      disposeTerminal();
      // Best-effort teardown of a still-active session (skip if it already
      // reached a terminal state, e.g. completed).
      const id = sessionIdRef.current;
      if (id && !finishedRef.current) {
        void cancelCodexSetupSession(id).catch(() => {});
      }
      sessionIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks read via refs; re-running only on open/retry is intentional
  }, [isOpen, retryNonce]);

  const handleRetry = () => setRetryNonce((n) => n + 1);

  const status = session?.status ?? null;
  const isActive =
    createPhase === 'created' && status !== null && !isTerminalCodexSetupStatus(status);
  const isCompleted = status === 'completed';
  const isFailure = status !== null && isFailureStatus(status);

  const header = (
    <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-border-default">
      <h2 id={titleId} className="text-base font-semibold text-fg-primary m-0">
        Connect with Codex
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="text-fg-muted bg-transparent border-none cursor-pointer text-lg leading-none px-1"
      >
        ×
      </button>
    </div>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="lg"
      stickyHeader={header}
      aria-labelledby={titleId}
    >
      <div className="flex flex-col gap-4">
        {createPhase === 'creating' && (
          <p className="text-sm text-fg-muted m-0" role="status">
            Starting guided setup…
          </p>
        )}

        {createPhase === 'blocked' && blockedMessage && (
          <>
            <Alert variant="info">{blockedMessage}</Alert>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" size="sm" onClick={handleRetry}>
                Try again
              </Button>
            </div>
          </>
        )}

        {createPhase === 'error' && createError && (
          <>
            <Alert variant="error">{createError}</Alert>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" size="sm" onClick={handleRetry}>
                Try again
              </Button>
            </div>
          </>
        )}

        {createPhase === 'created' && status !== null && (
          <>
            <div className="flex items-center gap-2" role="status" aria-live="polite">
              <span
                aria-hidden="true"
                className={`inline-block w-2 h-2 rounded-full ${
                  isCompleted
                    ? 'bg-success'
                    : isFailure
                      ? 'bg-danger'
                      : 'bg-accent animate-pulse'
                }`}
              />
              <span className="text-sm font-medium text-fg-primary">{statusLabel(status)}</span>
            </div>

            {isCompleted && (
              <Alert variant="success">
                Codex connected. Your ChatGPT subscription credential was saved.
              </Alert>
            )}

            {isFailure && (
              <Alert variant="error">
                {session?.errorMessage ?? 'The guided setup session ended before completing.'}
              </Alert>
            )}

            {terminalError && !isFailure && <Alert variant="error">{terminalError}</Alert>}

            {isActive && (
              <p className="text-xs text-fg-muted m-0">
                A sign-in link and code will appear in the terminal below. Open the link in your
                browser and enter the code to finish connecting your ChatGPT account.
              </p>
            )}

            {/* Terminal surface — kept mounted for the whole active session so the
                ref is stable; xterm fills it once the socket connects. */}
            {(isActive || isCompleted) && (
              <div
                ref={containerRef}
                data-testid="codex-terminal"
                className="w-full h-72 rounded-md overflow-hidden bg-[#1a1b26] p-2"
              />
            )}

            <div className="flex gap-2 justify-end">
              {isActive && (
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Cancel
                </Button>
              )}
              {isFailure && (
                <>
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    Close
                  </Button>
                  <Button variant="primary" size="sm" onClick={handleRetry}>
                    Try again
                  </Button>
                </>
              )}
              {isCompleted && (
                <Button variant="primary" size="sm" onClick={onClose}>
                  Done
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
