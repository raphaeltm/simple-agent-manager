import { Alert, Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { Github } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { connectProvider } from '../../../lib/auth';
import { connectedProvidersQueryOptions } from '../../ConnectedAccountsSection';

/**
 * The onboarding GitHub step for an account that signed in by email: SAM can only see the App's
 * installations through the user's own GitHub authorization, so connect GitHub first. Accounts
 * that already have GitHub (or whose status cannot be read) see the step unchanged.
 */
export function GitHubConnectGate({ children }: { children: ReactNode }) {
  const queryScope = useQueryScope();
  const connected = useQuery(connectedProvidersQueryOptions(queryScope));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsConnect = connected.isSuccess && !connected.data.includes('github');
  if (!needsConnect) return <>{children}</>;

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      await connectProvider('github');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect GitHub');
      setBusy(false);
    }
  };

  return (
    <div data-testid="onboarding-connect-github">
      <p className="mt-0 mb-3 text-sm text-fg-muted">
        You signed in with an email code, so connect your GitHub account first. Then install the
        GitHub app here.
      </p>
      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Button
        variant="accent"
        size="lg"
        className="w-full sm:w-auto"
        onClick={() => void handleConnect()}
        loading={busy}
      >
        <Github className="h-4 w-4" aria-hidden="true" />
        Connect GitHub
      </Button>
    </div>
  );
}
