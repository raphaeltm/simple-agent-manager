/**
 * /try/cap-exceeded — Shown when the monthly trial cap is hit.
 *
 * Offers the user two CTAs:
 *   1. Sign in with GitHub (go through OAuth and use their own credentials)
 *   2. Join the waitlist (email capture -> POST /api/trial/waitlist)
 */
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { joinWaitlist } from '../lib/trial-api';

// Light client-side check; server does the authoritative validation.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function TryCapExceeded() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const resetsAtIso = params.get('resetsAt');
  const resetsAt = resetsAtIso ? formatResetDate(resetsAtIso) : null;

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;

    const trimmed = email.trim();
    if (!trimmed || !EMAIL_REGEX.test(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await joinWaitlist(trimmed);
      navigate('/try/waitlist/thanks');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the waitlist.');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-[100dvh] bg-canvas flex items-center justify-center px-4 py-8"
      style={{
        paddingTop: 'max(2rem, env(safe-area-inset-top))',
        paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
      }}
    >
      <main className="w-full max-w-[640px] flex flex-col gap-6" aria-labelledby="cap-heading">
        <header className="text-center">
          <h1 id="cap-heading" className="sam-type-page-title text-fg-primary m-0 mb-2">
            We’ve hit our trial cap this month
          </h1>
          <p className="text-fg-muted">
            Thanks to everyone who tried SAM. We’re keeping costs controlled while we grow.
            {resetsAt ? (
              <>
                {' '}
                Trials reset on <strong>{resetsAt}</strong>.
              </>
            ) : null}
          </p>
        </header>

        <div className="flex flex-col gap-3">
          <Button
            size="lg"
            onClick={() => {
              window.location.href = '/';
            }}
            className="w-full min-h-14"
          >
            Continue with your own GitHub account
          </Button>
        </div>

        <div className="border-t border-border-default pt-6">
          <h2 className="sam-type-section-heading text-fg-primary m-0 mb-2 text-center">
            Or join the waitlist
          </h2>
          <p className="text-fg-muted text-sm text-center mb-4">
            We’ll ping you as soon as trials re-open{resetsAt ? ` on ${resetsAt}` : ''}.
          </p>

          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
            <label htmlFor="waitlist-email" className="sr-only">
              Email address
            </label>
            <Input
              id="waitlist-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={submitting}
              aria-invalid={error ? 'true' : 'false'}
              aria-describedby={error ? 'waitlist-email-error' : undefined}
              className="min-h-14 text-base"
              style={{ fontSize: '16px' }}
            />

            {error ? (
              <Alert variant="error" className="text-sm">
                <span id="waitlist-email-error">{error}</span>
              </Alert>
            ) : null}

            <Button
              type="submit"
              size="lg"
              loading={submitting}
              disabled={submitting}
              variant="secondary"
              className="w-full min-h-14"
            >
              Join the waitlist
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}

function formatResetDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
