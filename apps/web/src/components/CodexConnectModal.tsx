import { Alert, Button, Dialog } from '@simple-agent-manager/ui';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import {
  type AgentCredentialSetupSession,
  type AgentCredentialSetupStatus,
  cancelAgentCredentialSetupSession,
  createAgentCredentialSetupSession,
  getAgentCredentialSetupSession,
  type GuidedSetupAgentType,
  isTerminalAgentCredentialSetupStatus,
  submitAgentCredentialSetupCredential,
} from '../lib/api';

interface AgentCredentialConnectModalProps {
  agentType: GuidedSetupAgentType;
  isOpen: boolean;
  onClose: () => void;
  onConnected?: () => void;
}

type CodexConnectModalProps = Omit<AgentCredentialConnectModalProps, 'agentType'>;

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SUCCESS_CLOSE_DELAY_MS = 1500;

const SETUP_COPY: Record<
  GuidedSetupAgentType,
  {
    title: string;
    shortName: string;
    providerName: string;
    openLabel: string;
    readyInstructions: string;
    codeLabel: string;
    manualReturnHint: string;
    successMessage: string;
  }
> = {
  'openai-codex': {
    title: 'Connect with Codex',
    shortName: 'Codex',
    providerName: 'OpenAI',
    openLabel: 'Open OpenAI sign-in',
    readyInstructions: 'Open the secure OpenAI sign-in page, then enter this one-time code.',
    codeLabel: 'One-time code',
    manualReturnHint:
      'You can return here after approving access. This window updates automatically.',
    successMessage: 'Codex connected. Your ChatGPT subscription credential was saved.',
  },
  'claude-code': {
    title: 'Connect with Claude Code',
    shortName: 'Claude Code',
    providerName: 'Claude',
    openLabel: 'Open Claude sign-in',
    readyInstructions: 'Open the secure Claude sign-in page to authorize Claude Code.',
    codeLabel: 'Verification code',
    manualReturnHint:
      'You can return here after approving access. This window updates automatically.',
    successMessage: 'Claude Code connected. Your Claude subscription credential was saved.',
  },
};

function getPollIntervalMs(): number {
  return Number(import.meta.env.VITE_CODEX_SETUP_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS);
}

function getSuccessCloseDelayMs(): number {
  return Number(
    import.meta.env.VITE_CODEX_SETUP_SUCCESS_CLOSE_MS ?? DEFAULT_SUCCESS_CLOSE_DELAY_MS
  );
}

function statusLabel(status: AgentCredentialSetupStatus, shortName: string): string {
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
      return `${shortName} setup cancelled`;
  }
}

function isFailureStatus(status: AgentCredentialSetupStatus): boolean {
  return status === 'failed' || status === 'expired' || status === 'cancelled';
}

export function AgentCredentialConnectModal({
  agentType,
  isOpen,
  onClose,
  onConnected,
}: AgentCredentialConnectModalProps) {
  const titleId = useId();
  const copy = SETUP_COPY[agentType];
  const [phase, setPhase] = useState<'creating' | 'created' | 'blocked' | 'error'>('creating');
  const [session, setSession] = useState<AgentCredentialSetupSession | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [submittedCredential, setSubmittedCredential] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittingCredential, setSubmittingCredential] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  const finishedRef = useRef(false);
  const credentialSubmitInFlightRef = useRef(false);
  const manualCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setSubmittedCredential('');
    setSubmitError(null);
    setSubmittingCredential(false);
    credentialSubmitInFlightRef.current = false;
    if (manualCloseTimerRef.current) clearTimeout(manualCloseTimerRef.current);
    manualCloseTimerRef.current = null;
    sessionIdRef.current = null;
    finishedRef.current = false;

    const finish = (next: AgentCredentialSetupSession) => {
      if (finishedRef.current || !isTerminalAgentCredentialSetupStatus(next.status)) return;
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
      if (
        !sessionIdRef.current ||
        pollInFlight ||
        finishedRef.current ||
        credentialSubmitInFlightRef.current
      )
        return;
      pollInFlight = true;
      try {
        const next = await getAgentCredentialSetupSession(sessionIdRef.current);
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
        const result = await createAgentCredentialSetupSession(agentType);
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
        if (!isTerminalAgentCredentialSetupStatus(result.session.status)) {
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
      if (manualCloseTimerRef.current) clearTimeout(manualCloseTimerRef.current);
      manualCloseTimerRef.current = null;
      sessionIdRef.current = null;
    };
  }, [agentType, isOpen, retryNonce]);

  const handleCopy = async () => {
    if (!session?.userCode) return;
    try {
      await navigator.clipboard.writeText(session.userCode);
      setCopied(true);
    } catch {
      setMessage('Could not copy the code. Press and hold the code to copy it.');
    }
  };

  const handleSubmitCredential = async () => {
    const id = sessionIdRef.current;
    const credential = submittedCredential.trim();
    if (!id || !credential) {
      setSubmitError('Paste the Claude token from the browser first.');
      return;
    }

    credentialSubmitInFlightRef.current = true;
    setSubmittingCredential(true);
    setSubmitError(null);
    setMessage(null);
    setSession((current) => (current ? { ...current, status: 'saving' } : current));

    try {
      const next = await submitAgentCredentialSetupCredential(id, credential);
      setSession(next);
      setSubmittedCredential('');
      if (isTerminalAgentCredentialSetupStatus(next.status)) {
        finishedRef.current = true;
        if (next.status === 'completed') {
          onConnectedRef.current?.();
          manualCloseTimerRef.current = setTimeout(() => {
            onCloseRef.current();
          }, getSuccessCloseDelayMs());
        }
      }
    } catch (error) {
      setSession((current) =>
        current && current.status === 'saving'
          ? { ...current, status: 'waiting_for_user' }
          : current
      );
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Failed to save the Claude token. Please try again.'
      );
    } finally {
      credentialSubmitInFlightRef.current = false;
      setSubmittingCredential(false);
    }
  };

  const handleCancel = async () => {
    const id = sessionIdRef.current;
    finishedRef.current = true;
    if (id) await cancelAgentCredentialSetupSession(id).catch(() => {});
    onClose();
  };

  const status = session?.status ?? null;
  const isCompleted = status === 'completed';
  const isFailure = status !== null && isFailureStatus(status);
  const isActive =
    phase === 'created' && status !== null && !isTerminalAgentCredentialSetupStatus(status);
  const ready = isActive && !!session?.verificationUrl;
  const hasCode = ready && !!session?.userCode;
  const canSubmitClaudeCredential = ready && agentType === 'claude-code' && status !== 'saving';
  const credentialInputId = `${titleId}-credential`;

  const header = (
    <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-border-default">
      <h2 id={titleId} className="text-base font-semibold text-fg-primary m-0">
        {copy.title}
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
              <span className="text-sm font-medium text-fg-primary">
                {statusLabel(status, copy.shortName)}
              </span>
            </div>

            {ready && (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-fg-muted m-0">{copy.readyInstructions}</p>
                <a
                  href={session.verificationUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-sm font-medium text-white no-underline"
                >
                  {copy.openLabel} <ExternalLink size={16} aria-hidden="true" />
                </a>
                {hasCode && (
                  <div className="rounded-lg border border-border-default bg-bg-secondary p-4">
                    <span className="block text-xs text-fg-muted mb-2">{copy.codeLabel}</span>
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
                )}
                {canSubmitClaudeCredential && (
                  <form
                    className="rounded-lg border border-border-default bg-bg-secondary p-4 flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSubmitCredential();
                    }}
                  >
                    <div className="flex flex-col gap-2">
                      <label
                        htmlFor={credentialInputId}
                        className="text-sm font-medium text-fg-primary"
                      >
                        Paste the Claude token from your browser
                      </label>
                      <input
                        id={credentialInputId}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        inputMode="text"
                        value={submittedCredential}
                        onChange={(event) => {
                          setSubmittedCredential(event.currentTarget.value);
                          setSubmitError(null);
                        }}
                        placeholder="sk-ant-oat…"
                        className="min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 py-2 text-sm text-fg-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                      />
                      <p className="text-xs text-fg-muted m-0">
                        After Claude shows a token, paste it here. SAM saves it encrypted and never
                        displays it again.
                      </p>
                    </div>
                    {submitError && <Alert variant="error">{submitError}</Alert>}
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={submittingCredential}
                      disabled={!submittedCredential.trim()}
                      className="self-start"
                    >
                      {submittingCredential ? 'Saving…' : 'Save Claude token'}
                    </Button>
                  </form>
                )}
                <p className="text-xs text-fg-muted m-0">{copy.manualReturnHint}</p>
              </div>
            )}

            {isCompleted && <Alert variant="success">{copy.successMessage}</Alert>}
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

export function CodexConnectModal(props: CodexConnectModalProps) {
  return <AgentCredentialConnectModal agentType="openai-codex" {...props} />;
}
