import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAuth } from '../components/AuthProvider';
import { useLoginProviders } from '../hooks/useLoginProviders';
import {
  type ConnectorConsent as Consent,
  decideConnectorConsent,
  getConnectorConsent,
} from '../lib/api/connector';
import { authClient } from '../lib/auth';

const scopeLabels: Record<string, string> = {
  'sam.read': 'See your projects, chats, tasks, and ideas',
  'sam.write': 'Start, steer, and stop work as you',
  offline_access: 'Stay connected until you revoke access',
};
export function ConnectorConsent() {
  const [params] = useSearchParams();
  const query = params.get('request') ?? '';
  const { isAuthenticated, isLoading } = useAuth();
  const providers = useLoginProviders();
  const [consent, setConsent] = useState<Consent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isAuthenticated || !query) return;
    let active = true;
    setConsent(null);
    setError(null);
    void getConnectorConsent(query)
      .then((value) => {
        if (active) setConsent(value);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated, query]);
  async function decide(approve: boolean) {
    if (!consent) return;
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await decideConnectorConsent(consent.handle, approve);
      window.location.assign(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish authorization');
      setBusy(false);
    }
  }
  async function login(provider: 'github' | 'google' | 'gitlab') {
    setBusy(true);
    try {
      await authClient.signIn.social({ provider, callbackURL: window.location.href });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-bg-primary text-fg-primary px-4 py-10 flex justify-center items-center">
      <section className="w-full max-w-md space-y-5 min-w-0">
        <div>
          <p className="text-sm text-fg-muted">SAM Connector</p>
          <h1 className="text-2xl font-semibold">Connect an app to SAM</h1>
        </div>
        {error && <Alert variant="error">{error}</Alert>}
        {!query ? (
          <Alert variant="error">
            This authorization link is incomplete. Start the connection again from your app.
          </Alert>
        ) : isLoading ? (
          <Spinner />
        ) : !isAuthenticated ? (
          <>
            <p>Sign in to review this app’s access.</p>
            {(['github', 'google', 'gitlab'] as const)
              .filter((provider) => providers[provider])
              .map((provider) => (
                <Button
                  key={provider}
                  className="w-full min-h-14"
                  disabled={busy}
                  onClick={() => void login(provider)}
                >
                  Continue with{' '}
                  {provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : 'Google'}
                </Button>
              ))}
          </>
        ) : consent ? (
          <>
            <div className="rounded-lg border border-border-default p-5 space-y-4 break-words">
              <h2 className="text-lg font-semibold">{consent.clientName} wants access</h2>
              <p className="text-sm text-fg-muted">
                You will return to{' '}
                <strong className="text-fg-primary">{consent.redirectHost}</strong>.
              </p>
              {consent.loopback && (
                <Alert variant="warning">
                  This app returns to a local program on this device. Only approve if you started
                  the connection here.
                </Alert>
              )}
              <ul className="space-y-3 list-disc pl-5">
                {consent.scopes.map((scope) => (
                  <li key={scope}>{scopeLabels[scope] ?? scope}</li>
                ))}
              </ul>
            </div>
            <p className="text-sm text-fg-muted">
              Approve only apps you trust. You can revoke access anytime in Settings → Access.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="secondary"
                className="min-h-14"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                Deny
              </Button>
              <Button className="min-h-14" disabled={busy} onClick={() => void decide(true)}>
                {busy ? 'Continuing…' : 'Approve'}
              </Button>
            </div>
          </>
        ) : (
          !error && <Spinner />
        )}
      </section>
    </main>
  );
}
