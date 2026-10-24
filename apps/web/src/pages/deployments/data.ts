/**
 * Data for the Deployments pages. Every read is a TanStack Query keyed by the signed-in
 * identity, so refreshes keep what's on screen (stale-while-revalidate) and nothing from one
 * account can render for another. Polls speed up while something is changing on its own and
 * pause in hidden tabs (`lib/poll-intervals.ts`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAgentProfiles } from '../../hooks/useAgentProfiles';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import {
  attachDeploymentEnvironmentVolumes,
  createDeploymentCustomDomain,
  createDeploymentEnvironment,
  createDeploymentEnvironmentVolume,
  deleteDeploymentCustomDomain,
  deleteDeploymentEnvironment,
  deleteDeploymentEnvironmentConfigVar,
  deleteDeploymentEnvironmentVolume,
  detachDeploymentEnvironmentVolumes,
  getDeploymentEnvironmentConfig,
  getDeploymentEnvironmentLogs,
  getDeploymentEnvironmentMetrics,
  getProjectTask,
  listDeploymentCustomDomains,
  listDeploymentEnvironmentContainers,
  listDeploymentEnvironments,
  listDeploymentEnvironmentVolumes,
  listDeploymentPublicRoutes,
  listDeploymentReleaseEvents,
  listDeploymentReleases,
  startDeploymentEnvironment,
  stopDeploymentEnvironment,
  updateDeploymentEnvironmentPolicy,
  upsertDeploymentEnvironmentConfigVar,
  verifyDeploymentCustomDomain,
} from '../../lib/api';
import { DEPLOYMENTS_ACTIVE_POLL_MS, DEPLOYMENTS_IDLE_POLL_MS } from '../../lib/poll-intervals';
import { deploymentQueryKeys } from '../../lib/query-options';

const CHANGING_ENVIRONMENT = new Set(['starting', 'stopping']);
const IN_FLIGHT_RELEASE = new Set(['created', 'applying']);

export function useEnvironments(projectId: string) {
  const scope = useQueryScope();
  return useQuery({
    queryKey: deploymentQueryKeys.environments(scope, projectId),
    queryFn: () => listDeploymentEnvironments(projectId),
    enabled: Boolean(scope),
    select: (result) => result.environments,
    refetchInterval: (query) =>
      query.state.data?.environments?.some(
        (env) =>
          CHANGING_ENVIRONMENT.has(env.status) ||
          env.observedDeployment.status === 'applying' ||
          IN_FLIGHT_RELEASE.has(env.latestRelease?.status ?? '')
      )
        ? DEPLOYMENTS_ACTIVE_POLL_MS
        : DEPLOYMENTS_IDLE_POLL_MS,
  });
}

/** One environment from the shared list, plus how many environments share its server. */
export function useEnvironment(projectId: string, envId: string | undefined) {
  const environments = useEnvironments(projectId);
  const env = environments.data?.find((item) => item.id === envId) ?? null;
  const siblings = env?.nodeId
    ? (environments.data ?? []).filter((item) => item.nodeId === env.nodeId).length
    : 0;
  return { env, siblings, environments };
}

function useEnvQuery<T>(
  projectId: string,
  envId: string | undefined,
  part: string,
  fn: (envId: string) => Promise<T>,
  enabled = true,
  refetchInterval: number | false | ((data: T | undefined) => number | false) = false
) {
  const scope = useQueryScope();
  return useQuery({
    queryKey: deploymentQueryKeys.environment(scope, projectId, part, envId),
    queryFn: () => fn(envId ?? ''),
    enabled: Boolean(scope && envId && enabled),
    refetchInterval:
      typeof refetchInterval === 'function'
        ? (query) => refetchInterval(query.state.data)
        : refetchInterval,
  });
}

/** New releases show up without a reload; faster while one is on its way. */
export function useReleases(projectId: string, envId: string | undefined) {
  return useEnvQuery(
    projectId,
    envId,
    'releases',
    (id) => listDeploymentReleases(projectId, id),
    true,
    (data) =>
      data?.releases?.some((release) => IN_FLIGHT_RELEASE.has(release.status))
        ? DEPLOYMENTS_ACTIVE_POLL_MS
        : DEPLOYMENTS_IDLE_POLL_MS
  );
}

/** The steps a server reported for one release. `live` follows them while it applies. */
export function useReleaseEvents(
  projectId: string,
  envId: string | undefined,
  releaseId: string | undefined,
  enabled: boolean,
  live: boolean
) {
  return useEnvQuery(
    projectId,
    envId,
    `events:${releaseId}`,
    (id) => listDeploymentReleaseEvents(projectId, id, releaseId ?? ''),
    Boolean(releaseId) && enabled,
    live ? DEPLOYMENTS_ACTIVE_POLL_MS : false
  );
}

export function useConfig(projectId: string, envId: string | undefined) {
  return useEnvQuery(projectId, envId, 'config', (id) =>
    getDeploymentEnvironmentConfig(projectId, id)
  );
}

/** Domains change on their own while DNS and routing catch up, so keep them fresh. */
export function useDomains(projectId: string, envId: string | undefined) {
  return useEnvQuery(
    projectId,
    envId,
    'domains',
    async (id) => {
      const [routes, domains] = await Promise.all([
        listDeploymentPublicRoutes(projectId, id),
        listDeploymentCustomDomains(projectId, id),
      ]);
      return { routes: routes.publicRoutes ?? [], domains: domains.customDomains ?? [] };
    },
    true,
    (data) =>
      data?.domains.some(
        (domain) => domain.servingStatus === 'activating' || domain.desiredState === 'deactivating'
      )
        ? DEPLOYMENTS_ACTIVE_POLL_MS
        : DEPLOYMENTS_IDLE_POLL_MS
  );
}

export function useVolumes(projectId: string, envId: string | undefined) {
  return useEnvQuery(projectId, envId, 'volumes', (id) =>
    listDeploymentEnvironmentVolumes(projectId, id)
  );
}

export function useMetrics(projectId: string, envId: string | undefined, enabled: boolean) {
  return useEnvQuery(
    projectId,
    envId,
    'metrics',
    (id) => getDeploymentEnvironmentMetrics(projectId, id),
    enabled
  );
}

export function useContainers(projectId: string, envId: string | undefined, enabled: boolean) {
  return useEnvQuery(
    projectId,
    envId,
    'containers',
    (id) => listDeploymentEnvironmentContainers(projectId, id),
    enabled
  );
}

export type LogFilter = 'all' | 'errors' | 'app' | 'sam';

/** The newest log lines a sheet shows; search finds older ones. */
const LOG_LINES_SHOWN = 80;

export function useLogs(
  projectId: string,
  envId: string | undefined,
  filter: LogFilter,
  enabled: boolean,
  search = ''
) {
  return useEnvQuery(
    projectId,
    envId,
    `logs:${filter}:${search}`,
    (id) =>
      getDeploymentEnvironmentLogs(projectId, id, {
        limit: LOG_LINES_SHOWN,
        level: filter === 'errors' ? 'error' : undefined,
        source: filter === 'app' ? 'docker' : filter === 'sam' ? 'agent' : undefined,
        search: search || undefined,
      }),
    enabled
  );
}

/** The chat that sent a release. Tasks back every chat, and `/tasks/:id` opens it. */
export function useTaskTitle(projectId: string, taskId: string | null | undefined) {
  const scope = useQueryScope();
  return useQuery({
    queryKey: deploymentQueryKeys.task(scope, projectId, taskId),
    queryFn: () => getProjectTask(projectId, taskId ?? ''),
    enabled: Boolean(scope && taskId),
    select: (task) => task.title,
    staleTime: 5 * 60_000,
  });
}

export function useProfiles(projectId: string) {
  const scope = useQueryScope();
  return useAgentProfiles(projectId, scope).profiles;
}

/** Mutations refresh every Deployments query: few, cheap, and always right. */
function useInvalidate() {
  const scope = useQueryScope();
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: deploymentQueryKeys.all(scope) });
}

export function useEnvironmentActions(projectId: string, envId: string) {
  const invalidate = useInvalidate();
  const toast = useToast();
  // Every action reports its failure in words; none fails silently.
  const options = {
    onSuccess: () => void invalidate(),
    onError: (error: Error) => toast.error(error.message || "That didn't work. Try again."),
  };
  return {
    setAgentsEnabled: useMutation({
      mutationFn: (enabled: boolean) =>
        updateDeploymentEnvironmentPolicy(projectId, envId, { agentDeployEnabled: enabled }),
      ...options,
    }),
    setAllowedProfiles: useMutation({
      mutationFn: (ids: string[]) =>
        updateDeploymentEnvironmentPolicy(projectId, envId, { allowedDeployProfileIds: ids }),
      ...options,
    }),
    /** Turning deploys on always names who: an empty list means any agent. */
    allowAgents: useMutation({
      mutationFn: (ids: string[]) =>
        updateDeploymentEnvironmentPolicy(projectId, envId, {
          agentDeployEnabled: true,
          allowedDeployProfileIds: ids,
        }),
      ...options,
    }),
    pause: useMutation({
      mutationFn: () => stopDeploymentEnvironment(projectId, envId),
      onError: options.onError,
      onSuccess: (result) => {
        void invalidate();
        // The API reports cleanup it had to skip (for example, no server linked): show it.
        if (result.lifecycle.warnings.length > 0) {
          toast.warning(`Paused. SAM noted: ${result.lifecycle.warnings.join(' ')}`);
        }
      },
    }),
    start: useMutation({
      mutationFn: () => startDeploymentEnvironment(projectId, envId),
      ...options,
    }),
    remove: useMutation({
      mutationFn: () => deleteDeploymentEnvironment(projectId, envId),
      onError: options.onError,
      onSuccess: (result) => {
        void invalidate();
        if (result.warnings.length > 0)
          toast.warning(`Deleted. SAM noted: ${result.warnings.join(' ')}`);
      },
    }),
    saveSetting: useMutation({
      mutationFn: (input: { key: string; value: string; isSecret: boolean }) =>
        upsertDeploymentEnvironmentConfigVar(projectId, envId, input),
      ...options,
    }),
    removeSetting: useMutation({
      mutationFn: (key: string) => deleteDeploymentEnvironmentConfigVar(projectId, envId, key),
      ...options,
    }),
    /** Creating a domain only records it as pending; check DNS straight away. */
    addDomain: useMutation({
      mutationFn: async (input: { service: string; port: number; hostname: string }) => {
        const created = await createDeploymentCustomDomain(projectId, envId, input);
        return verifyDeploymentCustomDomain(projectId, envId, created.id);
      },
      onError: options.onError,
      // The domain exists even when the first DNS check fails: refresh either way.
      onSettled: () => void invalidate(),
    }),
    verifyDomain: useMutation({
      mutationFn: (domainId: string) => verifyDeploymentCustomDomain(projectId, envId, domainId),
      ...options,
    }),
    removeDomain: useMutation({
      mutationFn: (domainId: string) => deleteDeploymentCustomDomain(projectId, envId, domainId),
      ...options,
    }),
    addDisk: useMutation({
      mutationFn: (input: { name: string; sizeGb: number; location: string }) =>
        createDeploymentEnvironmentVolume(projectId, envId, input),
      ...options,
    }),
    removeDisk: useMutation({
      mutationFn: (volumeId: string) =>
        deleteDeploymentEnvironmentVolume(projectId, envId, volumeId),
      ...options,
    }),
    attachDisks: useMutation({
      mutationFn: () => attachDeploymentEnvironmentVolumes(projectId, envId),
      ...options,
    }),
    detachDisks: useMutation({
      mutationFn: () => detachDeploymentEnvironmentVolumes(projectId, envId),
      ...options,
    }),
  };
}

export function useCreateEnvironment(projectId: string) {
  const invalidate = useInvalidate();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: { name: string; agents: 'off' | 'any' | string[] }) => {
      const created = await createDeploymentEnvironment(projectId, input.name);
      if (input.agents === 'off') return created;
      return updateDeploymentEnvironmentPolicy(projectId, created.id, {
        agentDeployEnabled: true,
        allowedDeployProfileIds: input.agents === 'any' ? [] : input.agents,
      });
    },
    onError: (error: Error) =>
      toast.error(error.message || "Couldn't create the environment. Try again."),
    // Creation and access are two calls: refresh even when the second one fails.
    onSettled: () => void invalidate(),
  });
}
