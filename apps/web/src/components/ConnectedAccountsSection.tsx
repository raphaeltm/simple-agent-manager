import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useLoginProviders } from '../hooks/useLoginProviders';
import { useQueryScope } from '../hooks/useQueryScope';
import { connectProvider, type LinkableProvider, listConnectedProviders } from '../lib/auth';

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
 * `/link-social` flow. Unlinking is not offered.
 */
export function ConnectedAccountsSection() {
  const queryScope = useQueryScope();
  const { providers } = useLoginProviders();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<LinkableProvider | null>(null);
  const connected = useQuery(connectedProvidersQueryOptions(queryScope));

  const offered = (['github', 'gitlab'] as const).filter((provider) => providers?.[provider]);
  if (offered.length === 0) return null;

  const handleConnect = async (provider: LinkableProvider) => {
    setConnectError(null);
    setConnecting(provider);
    try {
      await connectProvider(provider);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Could not connect');
      setConnecting(null);
    }
  };

  return (
    <div className="glass-surface rounded-lg p-4 flex flex-col gap-3">
      <div>
        <p className="font-medium text-fg-primary">Your account</p>
        <p className="text-sm text-fg-muted">
          SAM uses your own GitHub (or GitLab) authorization to start work on a project&apos;s
          repository. Connect it here if you signed in with an email code.
        </p>
      </div>
      {connectError && (
        <Alert variant="error" onDismiss={() => setConnectError(null)}>
          {connectError}
        </Alert>
      )}
      {connected.isLoading ? (
        <Spinner size="sm" />
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {offered.map((provider) => {
            const isConnected = connected.data?.includes(provider) ?? false;
            const label = PROVIDER_LABELS[provider];
            return (
              <li
                key={provider}
                className="flex flex-wrap items-center justify-between gap-2 min-w-0"
                data-testid={`connected-provider-${provider}`}
              >
                <span className="text-sm text-fg-primary">
                  {label}
                  <span className="ml-2 text-xs text-fg-muted">
                    {isConnected ? 'Connected' : 'Not connected'}
                  </span>
                </span>
                {!isConnected && (
                  <Button
                    size="sm"
                    disabled={connecting !== null}
                    onClick={() => void handleConnect(provider)}
                  >
                    {connecting === provider ? 'Redirecting…' : `Connect ${label}`}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {connected.isError && (
        <p className="m-0 text-xs text-fg-muted">Could not read your connected accounts.</p>
      )}
    </div>
  );
}
