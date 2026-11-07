import { fetchPaginatedGcpAggregatedInstances, type GcpApiScope } from './gcp-api';
import {
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type { ProviderRequestContext } from './types';
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

/**
 * Read one instance by name from one zone. createVM uses this after creation: with zonal DNS a
 * VM of the same name can exist in another zone, and a project-wide lookup could return it.
 */
export async function getGcpInstanceInZone(
  scope: GcpApiScope,
  zone: string,
  name: string,
  context?: ProviderRequestContext
): Promise<GcpInstancePayload | null> {
  throwIfProviderRequestAborted(context);
  const headers = await scope.authHeaders(context);
  return await findNamedInstance(scope, [zone], name, headers, context);
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
