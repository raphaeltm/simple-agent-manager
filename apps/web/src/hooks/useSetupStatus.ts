import { hasByocComputeCredential } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';

import {
  githubInstallationsQueryOptions,
  instantRuntimeEnabledQueryOptions,
  projectListQueryOptions,
} from '../lib/query-options';
import { useAgentCatalog, useAgentCredentials } from './useAgentCatalog';
import { useCredentials } from './useCredentials';
import { useTrialStatus } from './useTrialStatus';

export interface SetupStatus {
  /** The user has their own BYOC compute credential. */
  hasCloud: boolean;
  /**
   * Agents have somewhere to run: the user's cloud account, Instant (Cloudflare Containers),
   * which needs no account, or the installation's own cloud account.
   */
  hasCompute: boolean;
  /** Instant (Cloudflare Containers) is available on this installation. */
  instantEnabled: boolean;
  /** The installation has its own cloud account that SAM can place agents on. */
  platformCompute: boolean;
  /** The GitHub App is installed on at least one account. */
  hasGitHub: boolean;
  /** The user has at least one project. */
  hasProject: boolean;
  /**
   * Agents have a repository to work on: the GitHub App is installed, or the user already has a
   * project (for example a SAM-hosted one on Cloudflare Artifacts, which needs no GitHub).
   */
  hasRepoSource: boolean;
  /** An agent can sign in: an active credential, or SAM-managed AI chosen for it. */
  hasAgent: boolean;
  /**
   * Onboarding is complete when the user has an agent that can sign in, somewhere for it to
   * run and a repository source. SAM-managed AI counts only once the user chose it; the
   * installation merely offering it does not complete onboarding.
   */
  isComplete: boolean;
  /** True until every read the answer depends on has settled (with data or an error). */
  loading: boolean;
}

/**
 * The reads that decide whether a user still needs onboarding.
 *
 * `OnboardingProvider` and `ChoosePathWizard` both derive exactly this, and `AppShell` mounts
 * both on **every** authenticated page, so everything here goes through shared query keys:
 * the two consumers share one request per endpoint, and so do the settings, workspace-creation
 * and project-chat surfaces that read the same endpoints.
 *
 * The fallbacks (project list, agent catalog, compute availability) are asked only when the
 * primary read did not already answer, so a fully set-up user pays nothing extra.
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
  const hasAgentCredential = agentCredentials.credentials.some((credential) => credential.isActive);

  const needsProjectCheck = Boolean(queryScope) && installationsQuery.isSuccess && !hasGitHub;
  const projectsQuery = useQuery({
    ...projectListQueryOptions(queryScope, 1),
    enabled: needsProjectCheck,
  });

  // SAM-managed AI is a saved setting, not a credential; the catalog reports it as configured.
  const needsCatalogCheck = Boolean(queryScope) && !agentCredentials.loading && !hasAgentCredential;
  const catalog = useAgentCatalog(needsCatalogCheck ? queryScope : '');

  // Compute without the user's own account: Instant, or the installation's cloud account.
  const needsComputeCheck = Boolean(queryScope) && !credentials.loading && !hasCloud;
  const instantQuery = useQuery({
    ...instantRuntimeEnabledQueryOptions(queryScope),
    enabled: needsComputeCheck,
  });
  const trial = useTrialStatus(needsComputeCheck ? queryScope : '');

  const hasProject = (projectsQuery.data ?? []).length > 0;
  const hasRepoSource = hasGitHub || hasProject;
  const hasAgent = hasAgentCredential || catalog.agents.some((agent) => agent.configured);
  const instantEnabled = instantQuery.data === true;
  const platformCompute = trial.trial?.hasInfraCredential === true;
  const hasCompute = hasCloud || instantEnabled || platformCompute;

  // Loading until every read has settled. Deciding on the first read to land read the others
  // as "absent": a fully set-up user on a fresh browser was shown the onboarding overlay for as
  // long as the slowest read took, then had it vanish. Each read still fails soft: a settled
  // error is not pending, so a failed read cannot hold the caller in a permanent loading state.
  const loading =
    Boolean(queryScope) &&
    (credentials.loading ||
      agentCredentials.loading ||
      installationsQuery.isPending ||
      (needsProjectCheck && projectsQuery.isPending) ||
      (needsCatalogCheck && catalog.loading) ||
      (needsComputeCheck && (instantQuery.isPending || trial.loading)));

  return {
    hasCloud,
    hasCompute,
    instantEnabled,
    platformCompute,
    hasGitHub,
    hasProject,
    hasRepoSource,
    hasAgent,
    isComplete: hasAgent && hasCompute && hasRepoSource,
    loading,
  };
}
