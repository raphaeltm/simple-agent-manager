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
import { parseProviderJson } from './validation';
import { expectObject, optionalArray, optionalString } from './validation-core';
import { type GcpInstancePayload, validateGcpInstance } from './validation-gcp';

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

const GCP_ZONE_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const GCP_INSTANCE_NAME_PATTERN = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const GCP_INSTANCE_ID_PATTERN = /^\d{1,20}$/;
const GCP_ZONAL_LIST_MAX_PAGES = 20;

/**
 * Find an instance in exactly one zone by numeric ID or name, with no label filter. A zonal
 * `instances.list` filtered on the documented `id` and `name` fields: `instances.get` documents
 * its path parameter as the instance name only, and SAM stores GCP instances by numeric ID.
 * Returns null only when every page of that zone's listing answered and none matched; any failed
 * page throws.
 */
export async function findGcpInstanceInZoneByIdOrName(
  scope: GcpApiScope,
  zone: string,
  idOrName: string,
  context?: ProviderRequestContext
): Promise<GcpInstancePayload | null> {
  throwIfProviderRequestAborted(context);
  const clauses: string[] = [];
  if (GCP_INSTANCE_ID_PATTERN.test(idOrName)) clauses.push(`(id = ${idOrName})`);
  if (GCP_INSTANCE_NAME_PATTERN.test(idOrName)) clauses.push(`(name = "${idOrName}")`);
  if (clauses.length === 0 || !GCP_ZONE_PATTERN.test(zone)) {
    throw new ProviderError('gcp', undefined, `Invalid GCP zonal lookup ${zone}/${idOrName}`, {
      category: 'invalid_config',
    });
  }
  const headers = await scope.authHeaders(context);
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < GCP_ZONAL_LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({ filter: clauses.join(' OR ') });
    if (pageToken) params.set('pageToken', pageToken);
    const operation = `findInstanceInZone.${zone}`;
    const res = await providerFetch(
      'gcp',
      `${scope.projectUrl}/zones/${zone}/instances?${params.toString()}`,
      { headers },
      scope.timeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    const root = expectObject(await parseProviderJson(res, 'gcp', operation), 'gcp', operation);
    for (const [index, item] of (optionalArray(root, 'items', 'gcp', operation) ?? []).entries()) {
      const instance = validateGcpInstance(item, `${operation}.items[${index}]`);
      if (instance.id === idOrName || instance.name === idOrName) return instance;
    }
    pageToken = optionalString(root, 'nextPageToken', 'gcp', operation) || undefined;
    if (!pageToken) return null;
    if (seen.has(pageToken)) {
      throw new ProviderError('gcp', undefined, `${operation}: repeated nextPageToken`);
    }
    seen.add(pageToken);
  }
  throw new ProviderError('gcp', undefined, `GCP zonal lookup in ${zone} exceeded its page limit`);
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
  // A scope the list could not read may hold the instance, so "not in the list" is only an
  // answer when every scope was read (as in `listGcpInstances`). Callers read a null as "this
  // instance does not exist" (strict deletion, provider-existence reconciliation).
  const unreachable: string[] = [];
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
        for (const [scopeKey, scopeData] of Object.entries(data.items)) {
          if (scopeData.warning?.code === GCP_UNREACHABLE_WARNING) unreachable.push(scopeKey);
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

  if (unreachable.length > 0) {
    throw new ProviderError(
      'gcp',
      undefined,
      `GCP instance lookup for ${idOrName} is incomplete: unreachable ${unreachable.join(', ')}`
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
