import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import {
  type AccountProject,
  type AccountsModel,
  buildAccountsModel,
} from '../components/accounts/account-model';
import {
  accountQueryKeys,
  agentQueryKeys,
  ccAttachmentsQueryOptions,
  ccConfigurationsQueryOptions,
  ccCredentialsQueryOptions,
  credentialLimitQueryKeys,
  credentialQueryKeys,
  myCredentialLimitsQueryOptions,
  projectListQueryOptions,
  resolutionStatusQueryOptions,
} from '../lib/query-options';
import { useQueryScope } from './useQueryScope';

/** Projects the account views can attribute coverage to (same cap as Advanced). */
const ACCOUNT_PROJECT_LIMIT = 100;

interface UseAccountsResult {
  model: AccountsModel | null;
  projects: AccountProject[];
  /** True only before the first complete load — refetches keep `model` visible. */
  isLoading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Every connected agent and cloud account, with roles and per-project coverage.
 *
 * The resolution-status request runs first because that route lazily backfills
 * the cc_* tables from legacy credentials; listing them earlier would show an
 * empty account list to a user who only ever used the legacy connect flows.
 * Usage limits and projects are enrichments: when they fail the accounts still
 * render, just without usage chips or coverage.
 */
export function useAccountsData(options?: {
  /** Always resolve coverage for this project, even past the list cap. */
  project?: AccountProject;
}): UseAccountsResult {
  const extraProjectId = options?.project?.id;
  const extraProjectName = options?.project?.name;
  const queryScope = useQueryScope();
  const enabled = Boolean(queryScope);
  const resolution = useQuery({ ...resolutionStatusQueryOptions(queryScope), enabled });
  const listsEnabled = enabled && resolution.isFetched;
  const credentials = useQuery({ ...ccCredentialsQueryOptions(queryScope), enabled: listsEnabled });
  const configurations = useQuery({
    ...ccConfigurationsQueryOptions(queryScope),
    enabled: listsEnabled,
  });
  const attachments = useQuery({ ...ccAttachmentsQueryOptions(queryScope), enabled: listsEnabled });
  const projects = useQuery({
    ...projectListQueryOptions(queryScope, ACCOUNT_PROJECT_LIMIT),
    enabled,
  });
  const limits = useQuery({ ...myCredentialLimitsQueryOptions(queryScope), enabled });

  const projectList = useMemo(() => {
    const list = (projects.data ?? []).map((project) => ({ id: project.id, name: project.name }));
    if (extraProjectId && !list.some((project) => project.id === extraProjectId)) {
      list.push({ id: extraProjectId, name: extraProjectName ?? extraProjectId });
    }
    return list;
  }, [projects.data, extraProjectId, extraProjectName]);

  const model = useMemo(() => {
    if (!credentials.data || !configurations.data || !attachments.data) return null;
    return buildAccountsModel({
      credentials: credentials.data,
      configurations: configurations.data,
      attachments: attachments.data,
      projects: projectList,
      resolution: resolution.data?.consumers ?? [],
      limits: limits.data?.credentials ?? [],
    });
  }, [
    credentials.data,
    configurations.data,
    attachments.data,
    projectList,
    resolution.data,
    limits.data,
  ]);

  const failed = [credentials, configurations, attachments].find((query) => query.error);
  const error =
    model === null && failed?.error
      ? failed.error instanceof Error
        ? failed.error.message
        : 'Failed to load accounts'
      : null;

  const retry = useCallback(() => {
    void resolution.refetch();
    void credentials.refetch();
    void configurations.refetch();
    void attachments.refetch();
  }, [resolution, credentials, configurations, attachments]);

  return {
    model,
    projects: projectList,
    isLoading: enabled && model === null && !error,
    error,
    retry,
  };
}

/**
 * Refresh everything an account mutation can change: the cc_* lists, the legacy
 * cloud-credential list (node pools and onboarding read it), agent credential
 * state, and usage limits.
 */
export function useInvalidateAccounts(): () => Promise<void> {
  const queryClient = useQueryClient();
  const queryScope = useQueryScope();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.all(queryScope) }),
      queryClient.invalidateQueries({ queryKey: credentialQueryKeys.all(queryScope) }),
      queryClient.invalidateQueries({ queryKey: agentQueryKeys.all(queryScope) }),
      queryClient.invalidateQueries({ queryKey: credentialLimitQueryKeys.all(queryScope) }),
    ]);
  }, [queryClient, queryScope]);
}
