import {
  fetchPaginatedGcpAggregatedInstances,
  GCP_UNREACHABLE_WARNING,
  type GcpApiScope,
  gcpLabelFilter,
} from './gcp-api';
import { gcpInstanceToVM } from './gcp-native-instance';
import {
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type { ProviderRequestContext, VMInstance } from './types';
import { ProviderError } from './types';
import { type GcpInstancePayload, parseProviderJson, validateGcpInstance } from './validation';

/**
 * Find a GCP instance by numeric ID or name: a direct GET per configured zone,
 * then the project-wide aggregated list of SAM-managed instances.
 */
export async function findGcpInstanceByIdOrName(
  scope: GcpApiScope,
  zones: readonly string[],
  idOrName: string,
  context?: ProviderRequestContext
): Promise<GcpInstancePayload | null> {
  throwIfProviderRequestAborted(context);
  const headers = await scope.authHeaders(context);
  const namedInstance = await findNamedInstance(scope, zones, idOrName, headers, context);
  if (namedInstance) return namedInstance;
  return await findAggregatedInstance(scope, idOrName, headers, context);
}

async function findNamedInstance(
  scope: GcpApiScope,
  zones: readonly string[],
  idOrName: string,
  headers: Record<string, string>,
  context?: ProviderRequestContext
): Promise<GcpInstancePayload | null> {
  for (const zone of zones) {
    throwIfProviderRequestAborted(context);
    try {
      const url = `${scope.projectUrl}/zones/${zone}/instances/${idOrName}`;
      const res = await providerFetch('gcp', url, { headers }, scope.timeoutMs, undefined, context);
      throwIfProviderRequestAborted(context);
      const instance = validateGcpInstance(
        await parseProviderJson(res, 'gcp', `findInstanceByIdOrName.${zone}`),
        `findInstanceByIdOrName.${zone}`
      );
      throwIfProviderRequestAborted(context);
      return instance;
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) continue;
      throw err;
    }
  }
  return null;
}

async function findAggregatedInstance(
  scope: GcpApiScope,
  idOrName: string,
  headers: Record<string, string>,
  context?: ProviderRequestContext
): Promise<GcpInstancePayload | null> {
  try {
    const filterStr = `labels.sam-managed=true`;
    let found: GcpInstancePayload | null = null;
    await fetchPaginatedGcpAggregatedInstances(
      scope,
      `${scope.projectUrl}/aggregated/instances`,
      new URLSearchParams({ filter: filterStr }),
      headers,
      'findInstanceByIdOrName.aggregated',
      (data) => {
        if (found || !data.items) return;
        for (const scopeData of Object.values(data.items)) {
          for (const instance of scopeData.instances || []) {
            if (instance.id === idOrName || instance.name === idOrName) {
              found = instance;
              return true;
            }
          }
        }
      },
      context
    );
    if (found) return found;
  } catch (err) {
    rethrowIfProviderRequestAborted(err, context);
    throw new ProviderError(
      'gcp',
      err instanceof ProviderError ? err.statusCode : undefined,
      `GCP aggregated instance lookup failed for ${idOrName}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined }
    );
  }

  return null;
}

/**
 * Every SAM-managed instance carrying `labels`, across every zone of the project. One aggregated
 * list covers all zones, so a VM in any zone is visible to orphan reconciliation and allocation
 * recovery, not only VMs in the zones SAM knows by name.
 */
export async function listGcpInstances(
  scope: GcpApiScope,
  labels: Record<string, string> | undefined,
  context?: ProviderRequestContext
): Promise<VMInstance[]> {
  throwIfProviderRequestAborted(context);
  const filter = gcpLabelFilter({ 'sam-managed': 'true', ...labels });
  const headers = await scope.authHeaders(context);
  const results: VMInstance[] = [];
  const unreachable: string[] = [];

  try {
    await fetchPaginatedGcpAggregatedInstances(
      scope,
      `${scope.projectUrl}/aggregated/instances`,
      new URLSearchParams({ filter }),
      headers,
      'listVMs.aggregated',
      (data) => {
        for (const [scopeKey, scopeData] of Object.entries(data.items ?? {})) {
          if (scopeData.warning?.code === GCP_UNREACHABLE_WARNING) unreachable.push(scopeKey);
          results.push(...(scopeData.instances ?? []).map((i) => gcpInstanceToVM(i)));
        }
      },
      context
    );
  } catch (err) {
    rethrowIfProviderRequestAborted(err, context);
    throw new ProviderError(
      'gcp',
      err instanceof ProviderError ? err.statusCode : undefined,
      `GCP instance list failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined }
    );
  }

  // An unreachable zone makes the inventory partial. Callers use this list to prove no SAM VM
  // is missing (orphan reconciliation, allocation recovery), so a partial list must fail closed
  // rather than read as "no VM there".
  if (unreachable.length > 0) {
    throw new ProviderError(
      'gcp',
      undefined,
      `GCP instance list is incomplete: unreachable ${unreachable.join(', ')}`
    );
  }

  return results;
}
