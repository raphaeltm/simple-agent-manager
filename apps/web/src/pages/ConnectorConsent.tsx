import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAuth } from '../components/AuthProvider';
import { useLoginProviders } from '../hooks/useLoginProviders';
import { useQueryScope } from '../hooks/useQueryScope';
import { decideConnectorConsent, getConnectorConsent } from '../lib/api/connector';
import { authClient } from '../lib/auth';
import { connectorQueryKeys } from '../lib/query-options/connector';

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
  const scope = useQueryScope();
  // Consent preview creates a bound one-use handle; never refresh it on focus/reconnect.
  const preview = useQuery({
    queryKey: connectorQueryKeys.consent(scope, query),
    queryFn: () => getConnectorConsent(query),
    enabled: isAuthenticated && Boolean(scope) && Boolean(query),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const consent = preview.data;
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const decision = useMutation({
    mutationFn: ({ handle, approve }: { handle: string; approve: boolean }) =>
      decideConnectorConsent(handle, approve),
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
  });
  const error = loginError ?? decision.error?.message ?? preview.error?.message;
  const busy = loggingIn || decision.isPending || decision.isSuccess;
  function decide(approve: boolean) {
    if (consent) decision.mutate({ handle: consent.handle, approve });
  }
  async function login(provider: 'github' | 'google' | 'gitlab') {
    setLoggingIn(true);
    try {
      await authClient.signIn.social({ provider, callbackURL: window.location.href });
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Sign-in failed');
      setLoggingIn(false);
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
