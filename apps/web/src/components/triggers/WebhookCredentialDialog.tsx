import type { WebhookCredential } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface WebhookCredentialDialogProps {
  credential: WebhookCredential;
  onClose: () => void;
  returnFocusTarget?: HTMLElement | null;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function WebhookCredentialDialog({
  credential,
  onClose,
  returnFocusTarget,
}: WebhookCredentialDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const acknowledgmentRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const curl = useMemo(
    () =>
      [
        `curl -X POST '${credential.endpointUrl}'`,
        `-H 'Authorization: Bearer ${credential.token}'`,
        "-H 'Content-Type: application/json'",
        "-H 'Idempotency-Key: unique-event-id'",
        `--data '{"event":{"action":"created"}}'`,
      ].join(' '),
    [credential]
  );

  useEffect(() => {
    returnFocusRef.current =
      returnFocusTarget ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    acknowledgmentRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusTarget]);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  useEffect(() => {
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && acknowledged) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [acknowledged, onClose]);

  return (
    <>
      <div
        className="fixed inset-0 glass-backdrop-dim z-[var(--sam-z-dialog-backdrop)]"
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhook-credential-title"
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 glass-modal glass-panel-container glass-composited rounded-lg shadow-lg p-5 z-[var(--sam-z-dialog)] w-[min(42rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto"
      >
        <div className="flex items-start gap-3 mb-4">
          <KeyRound className="text-warning shrink-0" size={22} />
          <div className="min-w-0">
            <h2 id="webhook-credential-title" className="sam-type-section-heading m-0">
              Save your webhook credential
            </h2>
            <p className="text-sm text-fg-muted mt-1 mb-0">
              This bearer token is shown once. SAM stores only a keyed hash and cannot recover it.
            </p>
          </div>
        </div>

        {(
          [
            ['Endpoint', credential.endpointUrl],
            ['Bearer token', credential.token],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="mb-3 min-w-0">
            <p className="text-xs font-medium text-fg-muted mb-1">{label}</p>
            <div className="flex items-start gap-2">
              <code className="flex-1 min-w-0 break-all rounded-md bg-surface px-3 py-2 text-xs text-fg-primary">
                {value}
              </code>
              <button
                type="button"
                onClick={() => void copy(label, value)}
                className="p-2 rounded-md border border-border-default bg-transparent text-fg-muted cursor-pointer"
                aria-label={`Copy ${label.toLowerCase()}`}
              >
                {copied === label ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
          </div>
        ))}

        <div className="mb-4 min-w-0">
          <p className="text-xs font-medium text-fg-muted mb-1">Example</p>
          <div className="relative">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-surface px-3 py-3 pr-11 text-xs text-fg-primary m-0">
              {curl}
            </pre>
            <button
              type="button"
              onClick={() => void copy('Example', curl)}
              className="absolute top-2 right-2 p-2 rounded-md border border-border-default bg-surface text-fg-muted cursor-pointer"
              aria-label="Copy curl example"
            >
              {copied === 'Example' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm text-fg-primary mb-4 cursor-pointer">
          <input
            ref={acknowledgmentRef}
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5"
          />
          I saved this token. Closing this dialog will permanently hide it.
        </label>
        <div className="flex justify-end">
          <Button onClick={onClose} disabled={!acknowledged}>
            Done
          </Button>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {copyError
            ? 'Copy failed. Select and copy the value manually.'
            : copied
              ? `${copied} copied.`
              : ''}
        </p>
      </div>
    </>
  );
}
