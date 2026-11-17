import { useQuery } from '@tanstack/react-query';
import { Github } from 'lucide-react';
import { type ReactNode } from 'react';
import { Link } from 'react-router';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { connectedProvidersQueryOptions } from '../../ConnectedAccountsSection';
import { useOnboarding } from '../OnboardingContext';

/**
 * The onboarding GitHub step for an account that signed in by email: SAM can only see the App's
 * installations through the user's own GitHub authorization, so connect GitHub first. Accounts
 * that already have GitHub (or whose status cannot be read) see the step unchanged.
 */
export function GitHubConnectGate({ children }: { children: ReactNode }) {
  const { dismissOnboarding } = useOnboarding();
  const queryScope = useQueryScope();
  const connected = useQuery(connectedProvidersQueryOptions(queryScope));
  const needsConnect = connected.isSuccess && !connected.data.includes('github');
  if (!needsConnect) return <>{children}</>;

  return (
    <div data-testid="onboarding-connect-github">
      <p className="mt-0 mb-3 text-sm text-fg-muted">
        Connect your GitHub account first. Then install the GitHub app here after returning to
        setup.
      </p>
      <Link
        to="/settings/github"
        onClick={dismissOnboarding}
        className="sam-raised inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--sam-radius-control)] px-4 text-sm font-medium text-fg-primary no-underline w-full sm:w-auto"
      >
        <Github className="h-4 w-4" aria-hidden="true" />
        Connect GitHub
      </Link>
    </div>
  );
}
