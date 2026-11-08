import { Button } from '@simple-agent-manager/ui';
import { ArrowRight, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { sendSignInCode, signInWithEmailCode } from '../lib/auth';

interface EmailCodeSignInProps {
  /** Pre-filled address, e.g. the installer owner arriving from first-run setup. */
  initialEmail?: string;
  /** Primary when email is the only way in; quieter when OAuth buttons sit above it. */
  primary: boolean;
  onSignedIn: () => void;
}

const inputClassName =
  'sam-well min-h-12 w-full rounded-[var(--sam-radius-control)] border-0 bg-transparent px-3.5 py-2.5 text-base text-fg-primary placeholder:text-fg-muted focus:outline focus:outline-2 focus:outline-[var(--sam-color-focus-ring)]';

/**
 * Two steps: ask for an address, then for the six-digit code SAM emailed to it. The API answers
 * the same whether or not the address can sign in, so the form always moves to the code step.
 */
export function EmailCodeSignIn({ initialEmail = '', primary, onSignedIn }: EmailCodeSignInProps) {
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const requestCode = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await sendSignInCode(email.trim().toLowerCase());
      setResent(stage === 'code');
      setStage('code');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signInWithEmailCode(email.trim().toLowerCase(), code.trim());
      onSignedIn();
    } catch {
      setError("That code didn't work. Check the latest email, or send a new code.");
      setBusy(false);
    }
  };

  if (stage === 'code') {
    return (
      <form onSubmit={verify} className="space-y-3 text-left" data-testid="email-code-form">
        <p className="text-sm text-fg-muted">
          If <span className="break-all font-medium text-fg-primary">{email.trim()}</span> can sign
          in here, a code is on its way.
        </p>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Sign-in code</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            className={`${inputClassName} text-center font-mono text-xl tracking-[0.4em]`}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger-fg">
            {error}
          </p>
        )}
        {resent && !error && (
          <p role="status" className="text-sm text-fg-muted">
            New code sent.
          </p>
        )}
        <Button
          type="submit"
          variant="accent"
          size="lg"
          className="w-full"
          disabled={code.length !== 6}
          loading={busy}
        >
          Sign in
          <ArrowRight className="h-5 w-5" aria-hidden="true" />
        </Button>
        <div className="flex justify-between gap-2 text-xs">
          <button
            type="button"
            onClick={() => {
              setStage('email');
              setCode('');
              setError(null);
              setResent(false);
            }}
            className="min-h-11 text-fg-muted underline underline-offset-2 hover:text-fg-primary"
          >
            Use a different email
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void requestCode()}
            className="min-h-11 text-fg-muted underline underline-offset-2 hover:text-fg-primary"
          >
            Send a new code
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={requestCode} className="space-y-3 text-left" data-testid="email-sign-in-form">
      <label className="block space-y-1.5">
        <span className="sr-only">Email</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          placeholder="you@example.com"
          required
          className={inputClassName}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant={primary ? 'accent' : 'raised'}
        size="lg"
        className="w-full"
        disabled={!email.includes('@')}
        loading={busy}
      >
        <Mail className="h-5 w-5" aria-hidden="true" />
        Email me a sign-in code
      </Button>
    </form>
  );
}
