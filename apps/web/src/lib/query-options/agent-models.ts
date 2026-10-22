import { queryOptions } from '@tanstack/react-query';

import { getAgentModelCatalog, getProjectAgentModelSettings } from '../api';

/**
 * Cloudflare-hosted models agents can call with `run_ai_model`.
 *
 * The catalog (`GET /api/agent-models/catalog`) is platform-wide, not
 * project-scoped, and changes only when SAM refreshes its Workers AI model
 * list — so it gets a long `staleTime` rather than the app default. It is
 * still nested under `['auth', queryScope, …]` because the response shape is
 * identical for every caller today but the endpoint is auth-gated; keying on
 * scope keeps the convention in `lib/query-options/index.ts` uniform and
 * avoids a cross-account cache hit if that ever changes.
 *
 * `projectSettings` is genuinely project-scoped (budget, selection, usage) and
 * carries `projectId` the same way `agentQueryKeys.profileList` does.
 */
const DEFAULT_AGENT_MODEL_CATALOG_STALE_TIME_MS = 30 * 60_000;

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const AGENT_MODEL_CATALOG_STALE_TIME_MS = envInt(
  import.meta.env.VITE_AGENT_MODEL_CATALOG_STALE_TIME_MS,
  DEFAULT_AGENT_MODEL_CATALOG_STALE_TIME_MS
);

export const agentModelQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'agent-models'] as const,
  catalog: (queryScope: string) => [...agentModelQueryKeys.all(queryScope), 'catalog'] as const,
  projectSettings: (queryScope: string, projectId: string) =>
    [...agentModelQueryKeys.all(queryScope), 'project', projectId] as const,
};

export function agentModelCatalogQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: agentModelQueryKeys.catalog(queryScope),
    queryFn: getAgentModelCatalog,
    staleTime: AGENT_MODEL_CATALOG_STALE_TIME_MS,
  });
}

export function projectAgentModelSettingsQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: agentModelQueryKeys.projectSettings(queryScope, projectId),
    queryFn: () => getProjectAgentModelSettings(projectId),
  });
}
