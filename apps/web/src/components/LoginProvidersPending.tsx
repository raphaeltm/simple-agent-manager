import { Button, Spinner } from '@simple-agent-manager/ui';

import type { LoginProvidersState } from '../hooks/useLoginProviders';

/**
 * Stands in for the sign-in options until the deployment says which ones it has, so a page never
 * shows a sign-in option that might not exist here.
 */
export function LoginProvidersPending({
  failed,
  retry,
}: Pick<LoginProvidersState, 'failed' | 'retry'>) {
  if (failed) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-2 text-sm text-fg-muted">
        <p>Couldn&rsquo;t load the sign-in options.</p>
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-label="Loading sign-in options"
      className="flex min-h-12 items-center justify-center py-2"
    >
      {/* The wrapper announces the state; hide the Spinner's own "Loading" status. */}
      <span aria-hidden="true">
        <Spinner size="md" />
      </span>
    </div>
  );
}
