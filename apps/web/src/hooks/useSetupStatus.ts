import { hasByocComputeCredential } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';

import { githubInstallationsQueryOptions } from '../lib/query-options';
import { useAgentCredentials } from './useAgentCatalog';
import { useCredentials } from './useCredentials';

export interface SetupStatus {
  /** The user has their own BYOC compute credential. */
  hasCloud: boolean;
  /** The GitHub App is installed on at least one account. */
  hasGitHub: boolean;
  /** The user has at least one active agent credential. */
  hasAgent: boolean;
  /**
   * Onboarding is complete only when the user has configured their OWN agent,
   * cloud and GitHub. Platform availability (SAM-managed AI tokens / SAM-managed
   * infrastructure) must NOT auto-complete onboarding — routing through SAM is
   * itself a decision the user makes inside onboarding.
   */
  isComplete: boolean;
  /** True only before any of the three reads has produced data. */
  loading: boolean;
}

/**
 * The three reads that decide whether a user still needs onboarding.
 *
 * `OnboardingProvider` and `ChoosePathWizard` both derive exactly this, and
 * `AppShell` mounts both of them on **every** authenticated page — so before this
 * hook existed, every page load issued `listCredentials`, `listGitHubInstallations`
 * and `listAgentCredentials` twice over, entirely independently of whatever the page
 * itself was fetching. That made the credential list the single most duplicated
 * request in the app.
 *
 * Routing both through shared query keys collapses those six requests to three, and
 * shares them with the settings, workspace-creation and project-chat surfaces that
 * read the same endpoints.
 */
export function useSetupStatus(queryScope: string): SetupStatus {
  const credentials = useCredentials(queryScope);
  const agentCredentials = useAgentCredentials(queryScope);
  const installationsQuery = useQuery({
    ...githubInstallationsQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  const hasCloud = hasByocComputeCredential(credentials.credentials);
  const hasGitHub = (installationsQuery.data ?? []).length > 0;
  const hasAgent = agentCredentials.credentials.some((credential) => credential.isActive);

  // Each read fails soft — the pre-migration code used `Promise.allSettled` and
  // treated a rejected read as "absent", so a transient failure must not be able to
  // hold the caller in a permanent loading state.
  const loading =
    Boolean(queryScope) &&
    (credentials.loading || agentCredentials.loading || installationsQuery.isPending) &&
    credentials.credentials.length === 0 &&
    agentCredentials.credentials.length === 0 &&
    installationsQuery.data === undefined;

  return { hasCloud, hasGitHub, hasAgent, isComplete: hasAgent && hasCloud && hasGitHub, loading };
}
