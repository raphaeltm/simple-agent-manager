import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useLoginProviders } from '../hooks/useLoginProviders';
import { useQueryScope } from '../hooks/useQueryScope';
import {
  connectProvider,
  disconnectProvider,
  type LinkableProvider,
  listConnectedProviders,
  requestProviderConnection,
  SessionNotFreshError,
  signOut,
} from '../lib/auth';
import { githubQueryKeys } from '../lib/query-options';

/** One cache entry for "which providers this account has connected", shared by every reader. */
export function connectedProvidersQueryOptions(queryScope: string) {
  return {
    queryKey: ['auth', queryScope, 'account', 'connected-providers'] as const,
    queryFn: listConnectedProviders,
    enabled: Boolean(queryScope),
  };
}

const PROVIDER_LABELS: Record<LinkableProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
};

/**
 * "Connect GitHub" (and GitLab where this installation offers it) for the signed-in account.
 *
 * An account that signed in by email has no GitHub link, and SAM needs the user's own GitHub
 * token to start work on a GitHub project. This links the provider through BetterAuth's
 * `/link-social` flow after an action-specific email sign-in check.
 */
export function ConnectedAccountsSection() {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).has('error')
      ? 'The connection was not completed. Request a new confirmation email to try again.'
      : null
  );
  const [confirmation, setConfirmation] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const provider = params.get('provider');
    const token = params.get('linkToken');
    return token && (provider === 'github' || provider === 'gitlab') ? { token, provider } : null;
  });
  useEffect(() => {
    if (confirmation)
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [confirmation]);
  const { providers } = useLoginProviders();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [needsFreshSignIn, setNeedsFreshSignIn] = useState(false);
  const [connecting, setConnecting] = useState<LinkableProvider | null>(null);
  const connected = useQuery(connectedProvidersQueryOptions(queryScope));

  const offered = (['github', 'gitlab'] as const).filter((provider) => providers?.[provider]);
  if (offered.length === 0) return null;

  const handleConnect = async (provider: LinkableProvider) => {
    setConnectError(null);
    setConnecting(provider);
    try {
      if (confirmation?.provider === provider) {
        await connectProvider(
          provider,
          window.location.origin + '/settings/github',
          confirmation.token
        );
      } else {
        await requestProviderConnection(provider);
        setNotice(
          `Check your account email to confirm connecting ${PROVIDER_LABELS[provider]}. Open the link in this browser.`
        );
        setConnecting(null);
      }
    } catch (err) {
      setConfirmation(null);
      setConnectError(err instanceof Error ? err.message : 'Could not connect');
      setConnecting(null);
    }
  };

  const handleDisconnect = async (provider: LinkableProvider) => {
    setConnectError(null);
    setNeedsFreshSignIn(false);
    setConnecting(provider);
    try {
      await disconnectProvider(provider);
      if (provider === 'github')
        void queryClient.invalidateQueries({ queryKey: githubQueryKeys.all(queryScope) });
      await queryClient.invalidateQueries({
        queryKey: connectedProvidersQueryOptions(queryScope).queryKey,
      });
      setNotice(
        `${PROVIDER_LABELS[provider]} disconnected. Existing repository work may need authorization again.`
      );
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Could not disconnect');
      setNeedsFreshSignIn(err instanceof SessionNotFreshError);
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div
      data-testid="connected-accounts"
      className="sam-glass sam-glass-rim rounded-[var(--sam-radius-pane)] p-4 flex flex-col gap-3 min-w-0"
    >
      <div>
        <p className="font-medium text-fg-primary">Connected accounts</p>
        <p className="text-sm text-fg-muted">
          SAM uses your own GitHub (or GitLab) authorization to start work on a project&apos;s
          repository. Connect it here if you signed in with an email code.
        </p>
      </div>
      {notice && <Alert variant="info">{notice}</Alert>}
      {confirmation && (
        <Alert variant="info">
          Confirm the connection below to finish the email sign-in check.
        </Alert>
      )}
      {connectError && (
        <Alert variant="error" onDismiss={() => setConnectError(null)}>
          {connectError}
          {needsFreshSignIn && (
            <Button variant="raised" size="sm" onClick={() => void signOut()}>
              Sign out to verify again
            </Button>
          )}
        </Alert>
      )}
      {connected.isLoading ? (
        <Spinner size="sm" />
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {offered.map((provider) => {
            const isConnected = connected.data?.includes(provider) ?? false;
            const label = PROVIDER_LABELS[provider];
            let statusLabel = 'Status unavailable';
            if (connected.isSuccess) statusLabel = isConnected ? 'Connected' : 'Not connected';
            let connectLabel = `Connect ${label}`;
            if (confirmation?.provider === provider)
              connectLabel = `Confirm connection to ${label}`;
            if (connecting === provider) connectLabel = 'Please wait…';
            return (
              <li
                key={provider}
                className="flex flex-wrap items-center justify-between gap-2 min-w-0"
                data-testid={`connected-provider-${provider}`}
              >
                <span className="text-sm text-fg-primary">
                  {label}
                  <span className="ml-2 text-xs text-fg-muted">{statusLabel}</span>
                </span>
                {!isConnected ? (
                  <Button
                    variant={
                      provider === (confirmation?.provider ?? 'github') ? 'accent' : 'raised'
                    }
                    className="min-h-11"
                    size="sm"
                    disabled={connecting !== null || !connected.isSuccess}
                    onClick={() => void handleConnect(provider)}
                  >
                    {connectLabel}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="min-h-11"
                    variant="raised"
                    disabled={connecting !== null || !connected.isSuccess}
                    onClick={() => void handleDisconnect(provider)}
                  >
                    Disconnect {label}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {connected.isError && (
        <Alert variant="error">
          Could not read your connected accounts.{' '}
          <Button variant="raised" size="sm" onClick={() => void connected.refetch()}>
            Try again
          </Button>
        </Alert>
      )}
    </div>
  );
}
