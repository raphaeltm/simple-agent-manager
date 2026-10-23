/**
 * PROTOTYPE data layer for the deployment takes. Every read goes through the real API
 * client so the takes render real `DeploymentEnvironment` shapes; Playwright mocks the
 * network for screenshots.
 *
 * Gaps the takes would need from the API are marked `NEEDS API` where they are used.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAgentProfiles } from '../../hooks/useAgentProfiles';
import { useQueryScope } from '../../hooks/useQueryScope';
import {
  attachDeploymentEnvironmentVolumes,
  createDeploymentCustomDomain,
  createDeploymentEnvironment,
  createDeploymentEnvironmentVolume,
  deleteDeploymentCustomDomain,
  deleteDeploymentEnvironment,
  deleteDeploymentEnvironmentConfigVar,
  deleteDeploymentEnvironmentVolume,
  type DeploymentEnvironment,
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
  request,
  startDeploymentEnvironment,
  stopDeploymentEnvironment,
  updateDeploymentEnvironmentPolicy,
  upsertDeploymentEnvironmentConfigVar,
  verifyDeploymentCustomDomain,
} from '../../lib/api';

/** One row of `GET /api/projects/:id/environments/:envId/releases` (exists, unused by the web app today). */
export interface ReleaseRecord {
  id: string;
  environmentId: string;
  version: number;
  status: string;
  createdBy: string;
  createdAt: string;
  /** NEEDS API: only `latestRelease` carries this today; the list endpoint should add it. */
  submittedBy?: {
    userId: string | null;
    workspaceId: string | null;
    taskId: string | null;
    agentProfileId: string | null;
  } | null;
}

function listReleases(projectId: string, envId: string) {
  return request<{ releases: ReleaseRecord[] }>(
    `/api/projects/${projectId}/environments/${envId}/releases`
  );
}

const root = (scope: string, projectId: string) => ['auth', scope, 'deploy-proto', projectId];

export function useEnvironments(projectId: string) {
  const scope = useQueryScope();
  return useQuery({
    queryKey: [...root(scope, projectId), 'envs'],
    queryFn: () => listDeploymentEnvironments(projectId),
    enabled: Boolean(scope),
    select: (result) => result.environments,
  });
}

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
  enabled = true
) {
  const scope = useQueryScope();
  return useQuery({
    queryKey: [...root(scope, projectId), envId, part],
    queryFn: () => fn(envId ?? ''),
    enabled: Boolean(scope && envId && enabled),
  });
}

export function useReleases(projectId: string, envId: string | undefined) {
  return useEnvQuery(projectId, envId, 'releases', (id) => listReleases(projectId, id));
}

export interface ReleaseEvent {
  seq: number;
  level: string;
  step: string | null;
  eventType: string;
  message: string;
  createdAt: string;
}

/**
 * The steps a server reported while applying one release. NEEDS API: nodes already write
 * these to `deployment_release_events` (fetch, compose up, health check, …), but no route
 * reads them back yet.
 */
export function useReleaseEvents(
  projectId: string,
  envId: string | undefined,
  releaseId: string | undefined,
  enabled = true
) {
  return useEnvQuery(
    projectId,
    envId,
    `events:${releaseId}`,
    (id) =>
      request<{ events: ReleaseEvent[] }>(
        `/api/projects/${projectId}/environments/${id}/releases/${releaseId}/events`
      ),
    Boolean(releaseId) && enabled
  );
}

/** Releases for every environment. NEEDS API: a project-level feed instead of one call each. */
export function useAllReleases(projectId: string, envs: DeploymentEnvironment[]) {
  const scope = useQueryScope();
  return useQueries({
    queries: envs.map((env) => ({
      queryKey: [...root(scope, projectId), env.id, 'releases'],
      queryFn: () => listReleases(projectId, env.id),
      enabled: Boolean(scope),
    })),
  });
}

export function useConfig(projectId: string, envId: string | undefined) {
  return useEnvQuery(projectId, envId, 'config', (id) =>
    getDeploymentEnvironmentConfig(projectId, id)
  );
}

export function useDomains(projectId: string, envId: string | undefined) {
  return useEnvQuery(projectId, envId, 'domains', async (id) => {
    const [routes, domains] = await Promise.all([
      listDeploymentPublicRoutes(projectId, id),
      listDeploymentCustomDomains(projectId, id),
    ]);
    return { routes: routes.publicRoutes, domains: domains.customDomains };
  });
}

/** Custom domains for every environment, so a list can show `shop.example.com` instead of the generated hostname. */
export function useAllDomains(projectId: string, envs: DeploymentEnvironment[]) {
  const scope = useQueryScope();
  return useQueries({
    queries: envs.map((env) => ({
      queryKey: [...root(scope, projectId), env.id, 'custom-domains'],
      queryFn: () => listDeploymentCustomDomains(projectId, env.id),
      enabled: Boolean(scope),
    })),
  });
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
        limit: 80,
        level: filter === 'errors' ? 'error' : undefined,
        source: filter === 'app' ? 'docker' : filter === 'sam' ? 'agent' : undefined,
        search: search || undefined,
      }),
    enabled
  );
}

/** The chat that deployed a release. Tasks back every chat, and `/tasks/:id` redirects to it. */
export function useTaskTitle(projectId: string, taskId: string | null | undefined) {
  const scope = useQueryScope();
  return useQuery({
    queryKey: ['auth', scope, 'deploy-proto', projectId, 'task', taskId],
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

/** Mutations invalidate the whole prototype cache: simple and correct for a prototype. */
function useInvalidate(projectId: string) {
  const scope = useQueryScope();
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: root(scope, projectId) });
}

export function useEnvironmentActions(projectId: string, envId: string) {
  const invalidate = useInvalidate(projectId);
  const options = { onSuccess: () => void invalidate() };
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
    pause: useMutation({ mutationFn: () => stopDeploymentEnvironment(projectId, envId), ...options }),
    start: useMutation({ mutationFn: () => startDeploymentEnvironment(projectId, envId), ...options }),
    remove: useMutation({ mutationFn: () => deleteDeploymentEnvironment(projectId, envId) }),
    saveSetting: useMutation({
      mutationFn: (input: { key: string; value: string; isSecret: boolean }) =>
        upsertDeploymentEnvironmentConfigVar(projectId, envId, input),
      ...options,
    }),
    removeSetting: useMutation({
      mutationFn: (key: string) => deleteDeploymentEnvironmentConfigVar(projectId, envId, key),
      ...options,
    }),
    addDomain: useMutation({
      mutationFn: (input: { service: string; port: number; hostname: string }) =>
        createDeploymentCustomDomain(projectId, envId, input),
      ...options,
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
      mutationFn: (volumeId: string) => deleteDeploymentEnvironmentVolume(projectId, envId, volumeId),
      ...options,
    }),
    attachDisks: useMutation({ mutationFn: () => attachDeploymentEnvironmentVolumes(projectId, envId), ...options }),
    detachDisks: useMutation({ mutationFn: () => detachDeploymentEnvironmentVolumes(projectId, envId), ...options }),
  };
}

export function useCreateEnvironment(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: async (input: { name: string; agents: 'off' | 'any' | string[] }) => {
      const created = await createDeploymentEnvironment(projectId, input.name);
      if (input.agents === 'off') return created;
      return updateDeploymentEnvironmentPolicy(projectId, created.id, {
        agentDeployEnabled: true,
        allowedDeployProfileIds: input.agents === 'any' ? [] : input.agents,
      });
    },
    onSuccess: () => void invalidate(),
  });
}
