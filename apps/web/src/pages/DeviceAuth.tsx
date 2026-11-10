import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAuth } from '../components/AuthProvider';
import { EmailCodeSignIn } from '../components/EmailCodeSignIn';
import { LoginProvidersPending } from '../components/LoginProvidersPending';
import { useLoginProviders } from '../hooks/useLoginProviders';
import { useToast } from '../hooks/useToast';
import { approveDeviceCode } from '../lib/api';
import { authClient } from '../lib/auth';

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export function DeviceAuth() {
  const [searchParams] = useSearchParams();
  const initialCode = useMemo(() => normalizeCode(searchParams.get('code') || ''), [searchParams]);
  const [code, setCode] = useState(initialCode);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isAuthenticated, isLoading } = useAuth();
  const { providers, failed: providersFailed, retry: retryProviders } = useLoginProviders();
  const toast = useToast();

  useEffect(() => {
    setCode(initialCode);
  }, [initialCode]);

  const returnPath = `/device${code ? `?code=${encodeURIComponent(normalizeCode(code))}` : ''}`;

  const handleLogin = async (provider: 'github' | 'google' | 'gitlab') => {
    await authClient.signIn.social({
      provider,
      callbackURL: window.location.origin + returnPath,
    });
  };

  const handleApprove = async () => {
    const normalized = normalizeCode(code);
    if (!normalized) {
      setError('Enter the code shown in your terminal.');
      return;
    }
    if (!isAuthenticated) {
      if (!providers) {
        setError('Sign-in options are still loading.');
      } else if (providers.github) {
        await handleLogin('github');
      } else if (providers.google) {
        await handleLogin('google');
      } else if (providers.gitlab) {
        await handleLogin('gitlab');
      } else if (providers.email) {
        setError('Sign in with your email below, then authorize.');
      } else {
        setError('No login provider is configured.');
      }
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await approveDeviceCode(normalized);
      setSuccess(true);
      toast.success('CLI authorized');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to authorize CLI');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-bg-primary text-fg-primary flex items-center justify-center px-4 py-8">
      <section className="w-full max-w-md space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-bg-secondary border border-border flex items-center justify-center">
            {success ? (
              <CheckCircle2 className="h-5 w-5 text-success" />
            ) : (
              <KeyRound className="h-5 w-5 text-fg-secondary" />
            )}
          </div>
          <div>
            <h1 className="text-xl font-semibold">Authorize SAM CLI</h1>
            <p className="text-sm text-fg-secondary">
              Approve the login request from your terminal.
            </p>
          </div>
        </div>

        {success ? (
          <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-2">
            <h2 className="text-sm font-medium text-fg-primary">CLI authorized</h2>
            <p className="text-sm text-fg-secondary">
              You can close this tab and return to your terminal.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-4">
            {error && (
              <Alert variant="error" onDismiss={() => setError(null)}>
                {error}
              </Alert>
            )}
            <label htmlFor="device-user-code" className="block space-y-2">
              <span className="text-sm font-medium text-fg-primary">User code</span>
              <Input
                id="device-user-code"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="ABCD-1234"
                className="font-mono tracking-wide"
              />
            </label>
            {isAuthenticated ? (
              <Button
                variant="primary"
                onClick={handleApprove}
                disabled={isLoading || submitting || !code.trim()}
                className="w-full"
              >
                {submitting ? 'Authorizing...' : 'Authorize'}
              </Button>
            ) : (
              <div className="space-y-2">
                {!providers && (
                  <LoginProvidersPending failed={providersFailed} retry={retryProviders} />
                )}
                {providers?.github && (
                  <Button
                    variant="primary"
                    onClick={handleApprove}
                    disabled={isLoading || submitting || !code.trim()}
                    className="w-full"
                  >
                    Log in with GitHub
                  </Button>
                )}
                {providers?.google && (
                  <Button
                    variant="secondary"
                    onClick={() => handleLogin('google')}
                    disabled={isLoading || submitting || !code.trim()}
                    className="w-full"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-sm font-semibold text-[#1a73e8]"
                    >
                      G
                    </span>
                    Log in with Google
                  </Button>
                )}
                {providers?.gitlab && (
                  <Button
                    variant="secondary"
                    onClick={() => handleLogin('gitlab')}
                    disabled={isLoading || submitting || !code.trim()}
                    className="w-full"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-5 w-5 items-center justify-center rounded-sm bg-[#fc6d26] text-[10px] font-bold text-white"
                    >
                      GL
                    </span>
                    Log in with GitLab
                  </Button>
                )}
                {providers?.email && (
                  // A code sign-in sets the session cookie outside BetterAuth's session store, so
                  // reload this page (code kept in the URL) for the provider to read it.
                  <EmailCodeSignIn
                    primary={!providers.github && !providers.google && !providers.gitlab}
                    onSignedIn={() => window.location.assign(returnPath)}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
