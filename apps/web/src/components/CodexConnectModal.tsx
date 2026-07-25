import { Alert, Button, Dialog } from '@simple-agent-manager/ui';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import {
  cancelCodexSetupSession,
  type CodexSetupSession,
  type CodexSetupStatus,
  createCodexSetupSession,
  getCodexSetupSession,
  isTerminalCodexSetupStatus,
} from '../lib/api';

interface CodexConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SUCCESS_CLOSE_DELAY_MS = 1500;

function getPollIntervalMs(): number {
  return Number(import.meta.env.VITE_CODEX_SETUP_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS);
}

function getSuccessCloseDelayMs(): number {
  return Number(
    import.meta.env.VITE_CODEX_SETUP_SUCCESS_CLOSE_MS ?? DEFAULT_SUCCESS_CLOSE_DELAY_MS
  );
}

function statusLabel(status: CodexSetupStatus): string {
  switch (status) {
    case 'creating':
    case 'admitting':
    case 'provisioning':
      return 'Preparing secure sign-in…';
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

function isFailureStatus(status: CodexSetupStatus): boolean {
  return status === 'failed' || status === 'expired' || status === 'cancelled';
}

export function CodexConnectModal({ isOpen, onClose, onConnected }: CodexConnectModalProps) {
  const titleId = useId();
  const [phase, setPhase] = useState<'creating' | 'created' | 'blocked' | 'error'>('creating');
  const [session, setSession] = useState<CodexSetupSession | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  const finishedRef = useRef(false);
  const onConnectedRef = useRef(onConnected);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onConnectedRef.current = onConnected;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    let pollInFlight = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    setPhase('creating');
    setSession(null);
    setMessage(null);
    setCopied(false);
    sessionIdRef.current = null;
    finishedRef.current = false;

    const finish = (next: CodexSetupSession) => {
      if (finishedRef.current || !isTerminalCodexSetupStatus(next.status)) return;
      finishedRef.current = true;
      if (pollTimer) clearInterval(pollTimer);
      if (next.status === 'completed') {
        onConnectedRef.current?.();
        closeTimer = setTimeout(() => {
          if (!cancelled) onCloseRef.current();
        }, getSuccessCloseDelayMs());
      }
    };

    const poll = async () => {
      if (!sessionIdRef.current || pollInFlight || finishedRef.current) return;
      pollInFlight = true;
      try {
        const next = await getCodexSetupSession(sessionIdRef.current);
        if (cancelled) return;
        setSession(next);
        finish(next);
      } catch {
        // Keep the last useful state visible and retry.
      } finally {
        pollInFlight = false;
      }
    };

    void (async () => {
      try {
        const result = await createCodexSetupSession();
        if (result.kind === 'created') sessionIdRef.current = result.session.id;
        if (cancelled) return;
        if (result.kind !== 'created') {
          setPhase('blocked');
          setMessage(result.message);
          return;
        }
        setPhase('created');
        setSession(result.session);
        finish(result.session);
        if (!isTerminalCodexSetupStatus(result.session.status)) {
          pollTimer = setInterval(() => void poll(), getPollIntervalMs());
        }
      } catch (error) {
        if (!cancelled) {
          setPhase('error');
          setMessage(error instanceof Error ? error.message : 'Failed to start guided setup');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (closeTimer) clearTimeout(closeTimer);
      sessionIdRef.current = null;
    };
  }, [isOpen, retryNonce]);

  const handleCopy = async () => {
    if (!session?.userCode) return;
    try {
      await navigator.clipboard.writeText(session.userCode);
      setCopied(true);
    } catch {
      setMessage('Could not copy the code. Press and hold the code to copy it.');
    }
  };

  const handleCancel = async () => {
    const id = sessionIdRef.current;
    finishedRef.current = true;
    if (id) await cancelCodexSetupSession(id).catch(() => {});
    onClose();
  };

  const status = session?.status ?? null;
  const isCompleted = status === 'completed';
  const isFailure = status !== null && isFailureStatus(status);
  const isActive = phase === 'created' && status !== null && !isTerminalCodexSetupStatus(status);
  const ready = isActive && !!session?.verificationUrl && !!session.userCode;

  const header = (
    <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-border-default">
      <h2 id={titleId} className="text-base font-semibold text-fg-primary m-0">
        Connect with Codex
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="text-fg-muted bg-transparent border-none cursor-pointer text-xl leading-none p-2 -mr-2"
      >
        ×
      </button>
    </div>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="md"
      stickyHeader={header}
      aria-labelledby={titleId}
    >
      <div className="flex flex-col gap-5">
        {phase === 'creating' && <p role="status">Starting guided setup…</p>}

        {(phase === 'blocked' || phase === 'error') && message && (
          <>
            <Alert variant={phase === 'error' ? 'error' : 'info'}>{message}</Alert>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
                Try again
              </Button>
            </div>
          </>
        )}

        {phase === 'created' && status && (
          <>
            <div className="flex items-center gap-2" role="status" aria-live="polite">
              <span
                aria-hidden="true"
                className={`inline-block w-2 h-2 rounded-full ${
                  isCompleted ? 'bg-success' : isFailure ? 'bg-danger' : 'bg-accent animate-pulse'
                }`}
              />
              <span className="text-sm font-medium text-fg-primary">{statusLabel(status)}</span>
            </div>

            {ready && (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-fg-muted m-0">
                  Open the secure OpenAI sign-in page, then enter this one-time code.
                </p>
                <a
                  href={session.verificationUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-sm font-medium text-white no-underline"
                >
                  Open OpenAI sign-in <ExternalLink size={16} aria-hidden="true" />
                </a>
                <div className="rounded-lg border border-border-default bg-bg-secondary p-4">
                  <span className="block text-xs text-fg-muted mb-2">One-time code</span>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <code className="select-all text-center sm:text-left text-2xl tracking-[0.18em] font-semibold text-fg-primary break-all">
                      {session.userCode}
                    </code>
                    <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
                      {copied ? (
                        <Check size={16} aria-hidden="true" />
                      ) : (
                        <Copy size={16} aria-hidden="true" />
                      )}
                      {copied ? 'Copied' : 'Copy code'}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-fg-muted m-0">
                  You can return here after approving access. This window updates automatically.
                </p>
              </div>
            )}

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
            {message && phase === 'created' && <Alert variant="info">{message}</Alert>}

            <div className="flex gap-2 justify-end">
              {isActive && status !== 'saving' && (
                <Button variant="ghost" size="sm" onClick={() => void handleCancel()}>
                  Cancel
                </Button>
              )}
              {isFailure && (
                <>
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    Close
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
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
