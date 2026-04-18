/**
 * /try — Zero-friction trial landing page.
 *
 * Mobile-first (375×667 authoritative). Accepts a public GitHub repo URL,
 * POSTs to /api/trial/create, and routes into TryDiscovery. All known
 * `TrialErrorCode` branches render inline; cap-exceeded redirects to a
 * dedicated page and waitlist flow.
 */
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { createTrial } from '../lib/trial-api';

// The regex is deliberately generous — server does the authoritative check.
// This exists to catch obvious paste mistakes before a round-trip.
const CLIENT_SIDE_URL_CHECK = /^https:\/\/github\.com\/[^/]+\/[^/]+/i;

export function Try() {
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trialsDisabled, setTrialsDisabled] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;

    const trimmed = repoUrl.trim();
    if (!trimmed) {
      setError('Please paste a GitHub repo URL.');
      return;
    }
    if (!CLIENT_SIDE_URL_CHECK.test(trimmed)) {
      setError('That doesn’t look like a GitHub URL (expected https://github.com/owner/repo).');
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const result = await createTrial(trimmed);

      if (result.ok && 'value' in result) {
        navigate(`/try/${result.value.trialId}`);
        return;
      }

      if (result.ok && 'existing' in result) {
        navigate(`/try/${result.existing.trialId}`);
        return;
      }

      // Error branch — route or render inline based on code.
      const code = result.error.error;
      if (code === 'cap_exceeded') {
        const query = result.error.waitlistResetsAt
          ? `?resetsAt=${encodeURIComponent(result.error.waitlistResetsAt)}`
          : '';
        navigate(`/try/cap-exceeded${query}`);
        return;
      }
      if (code === 'trials_disabled') {
        setTrialsDisabled(true);
        setError(null);
        return;
      }
      setError(result.error.message);
    } catch (err) {
      console.error('createTrial failed', err);
      setError('Network error — please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  if (trialsDisabled) {
    return <TrialsPausedPanel />;
  }

  return (
    <div
      className="min-h-[100dvh] bg-canvas flex flex-col items-center justify-center px-4 py-8"
      style={{
        paddingTop: 'max(2rem, env(safe-area-inset-top))',
        paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
      }}
    >
      <main className="w-full max-w-[640px] flex flex-col gap-6" aria-labelledby="try-heading">
        <header className="text-center">
          <h1 id="try-heading" className="sam-type-page-title text-fg-primary m-0 mb-2">
            Explore any GitHub repo with an AI agent
          </h1>
          <p className="text-fg-muted text-sm sm:text-base">
            Paste a public repo. SAM spins up a live workspace, analyzes the code, and shows you
            what it found — no signup required. Public repos only, ~20-minute session.
          </p>
        </header>

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
          <label htmlFor="trial-repo-url" className="sr-only">
            GitHub repo URL
          </label>
          <Input
            id="trial-repo-url"
            name="repoUrl"
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            disabled={submitting}
            aria-invalid={error ? 'true' : 'false'}
            aria-describedby={error ? 'trial-repo-error' : undefined}
            className="min-h-14 text-base"
            style={{ fontSize: '16px' }}
          />

          {error ? (
            <Alert variant="error" className="text-sm">
              <span id="trial-repo-error">{error}</span>
            </Alert>
          ) : null}

          <Button
            type="submit"
            size="lg"
            loading={submitting}
            disabled={submitting}
            className="w-full min-h-14"
          >
            Explore repo
          </Button>
        </form>

        <p className="text-center text-xs text-fg-muted">
          We’ll use our compute + LLM credits for the trial. Public repos only, one active trial
          per browser.
        </p>
      </main>
    </div>
  );
}

function TrialsPausedPanel() {
  const navigate = useNavigate();
  return (
    <div
      className="min-h-[100dvh] bg-canvas flex items-center justify-center px-4 py-8"
      style={{
        paddingTop: 'max(2rem, env(safe-area-inset-top))',
        paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
      }}
    >
      <main className="w-full max-w-[640px] text-center flex flex-col gap-4">
        <h1 className="sam-type-page-title text-fg-primary m-0">
          Trials are paused
        </h1>
        <p className="text-fg-muted">
          We’ve hit the pause button on free trials right now. Sign in with your GitHub account to
          keep exploring SAM, or join the waitlist for the next window.
        </p>
        <div className="flex flex-col gap-3">
          <Button
            size="lg"
            onClick={() => {
              window.location.href = '/';
            }}
            className="w-full min-h-14"
          >
            Sign in with GitHub
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onClick={() => navigate('/try/cap-exceeded')}
            className="w-full min-h-14"
          >
            Join the waitlist
          </Button>
        </div>
      </main>
    </div>
  );
}
