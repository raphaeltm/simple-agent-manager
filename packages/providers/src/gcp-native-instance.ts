import type { GcpApiScope } from './gcp-api';
import {
  DEFAULT_GCP_MACHINE_TYPE_LOOKUP_ATTEMPTS,
  DEFAULT_GCP_MACHINE_TYPE_LOOKUP_RETRY_DELAY_MS,
  extractIp,
  mapGcpStatus,
} from './gcp-metadata';
import { observedHardware } from './native-vm-config';
import {
  providerDelay,
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import {
  ProviderError,
  type ProviderRequestContext,
  type VMHardwareResources,
  type VMInstance,
} from './types';
import { parseProviderJson } from './validation';
import { expectObject, requirePositiveInteger } from './validation-core';
import type { GcpInstancePayload } from './validation-gcp';

/** vCPU and memory of a machine type, as `machineTypes.get` reports them. */
export interface GcpMachineTypeResources {
  vcpuCount: number;
  memoryMb: number;
}

const ZONAL_MACHINE_TYPE = /(?:^|\/)zones\/([a-z0-9-]+)\/machineTypes\/([a-z0-9-]+)$/;

export function gcpInstanceToVM(
  instance: GcpInstancePayload,
  machineType?: GcpMachineTypeResources | null
): VMInstance {
  const machineTypeName = instance.machineType.split('/').pop() || instance.machineType;
  // Provider-reported location: the zone GCP says the instance lives in (allocation recovery
  // compares it with the node's persisted vmLocation).
  const location = instance.zone?.split('/').pop() || undefined;
  return {
    id: instance.id || instance.name,
    name: instance.name,
    ...(location ? { location } : {}),
    ip: extractIp(instance.networkInterfaces),
    status: mapGcpStatus(instance.status),
    serverType: machineTypeName,
    observedHardware: observedHardware({
      serverType: machineTypeName,
      resources: gcpObservedResources(instance, machineType),
      unknownResourcesReason:
        'GCP machine type or boot disk size could not be read for this instance',
    }),
    createdAt: instance.creationTimestamp,
    labels: instance.labels || {},
  };
}

/**
 * Resources are reported only when vCPU, memory AND disk are all known. Workspace admission
 * (`resolveTrustedWorkspaceNodeCapacity` in apps/api) needs all three, so a partial answer is
 * no more useful than none, and an unknown one stays fail-closed.
 */
function gcpObservedResources(
  instance: GcpInstancePayload,
  machineType: GcpMachineTypeResources | null | undefined
): VMHardwareResources | null {
  if (!machineType || instance.bootDiskSizeGb === undefined) return null;
  return {
    vcpuCount: machineType.vcpuCount,
    memoryMb: machineType.memoryMb,
    diskGb: instance.bootDiskSizeGb,
  };
}

/**
 * Map an instance to a VM with its observed hardware. The instance resource names its machine
 * type but not the type's vCPU or memory, so they are read with `machineTypes.get`
 * (https://cloud.google.com/compute/docs/reference/rest/v1/machineTypes/get).
 *
 * The lookup is retried a bounded number of times, because observed hardware is written once at
 * provisioning. If every attempt fails the resources stay unknown instead of failing the caller:
 * after createVM the instance already exists, and throwing there would orphan it. Cancellation
 * always propagates.
 */
export async function gcpInstanceToObservedVM(
  scope: GcpApiScope,
  instance: GcpInstancePayload,
  context?: ProviderRequestContext,
  retry: { attempts: number; delayMs: number } = {
    attempts: DEFAULT_GCP_MACHINE_TYPE_LOOKUP_ATTEMPTS,
    delayMs: DEFAULT_GCP_MACHINE_TYPE_LOOKUP_RETRY_DELAY_MS,
  }
): Promise<VMInstance> {
  let machineType: GcpMachineTypeResources | null = null;
  for (let attempt = 1; attempt <= Math.max(1, retry.attempts); attempt++) {
    try {
      machineType = await fetchGcpMachineTypeResources(scope, instance.machineType, context);
      break;
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (attempt >= retry.attempts || !isTransientMachineTypeLookupError(err)) break;
      await providerDelay(retry.delayMs, context);
    }
  }
  return gcpInstanceToVM(instance, machineType);
}

/**
 * Worth another try: GCP rate limiting (429), a server error (5xx), or our own request timeout
 * (`providerFetch` wraps the timed-out fetch's AbortError/TimeoutError as `cause`). A 4xx or a
 * malformed body will fail the same way again, so those give up at once.
 */
function isTransientMachineTypeLookupError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.statusCode !== undefined) return err.statusCode === 429 || err.statusCode >= 500;
  const cause = err.cause;
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}

/**
 * Read a zonal machine type's vCPU and memory. The URL is rebuilt from the project scope rather
 * than following the instance's `machineType` link, so a response can't redirect the
 * authenticated request to another host.
 */
export async function fetchGcpMachineTypeResources(
  scope: GcpApiScope,
  machineTypeRef: string,
  context?: ProviderRequestContext
): Promise<GcpMachineTypeResources | null> {
  const match = ZONAL_MACHINE_TYPE.exec(machineTypeRef);
  if (!match) return null;
  const [, zone, name] = match;
  throwIfProviderRequestAborted(context);
  const headers = await scope.authHeaders(context);
  const res = await providerFetch(
    'gcp',
    `${scope.projectUrl}/zones/${zone}/machineTypes/${name}`,
    { headers },
    scope.timeoutMs,
    undefined,
    context
  );
  throwIfProviderRequestAborted(context);
  const ctx = 'machineTypes.get';
  const root = expectObject(await parseProviderJson(res, 'gcp', ctx), 'gcp', ctx);
  return {
    vcpuCount: requirePositiveInteger(root, 'guestCpus', 'gcp', ctx),
    memoryMb: requirePositiveInteger(root, 'memoryMb', 'gcp', ctx),
  };
}

export function resolveGcpSourceImage(image: string, imageProject: string): string {
  const trimmed = image.trim();
  const projectScopedImageRef = /^projects\/[^/]+\/global\/images\/(?:family\/)?[^/]+$/;
  const globalImageRef = /^global\/images\/(?:family\/)?[^/]+$/;
  const shortFamilyRef = /^family\/[^/]+$/;
  const shortImageRef = /^images\/[^/]+$/;
  const familyName = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

  if (
    /^https:\/\/(?:(?:www|compute)\.)googleapis\.com\/compute\/v1\/projects\/[^/]+\/global\/images\/(?:family\/)?[^/]+$/.test(
      trimmed
    )
  ) {
    return trimmed;
  }
  if (projectScopedImageRef.test(trimmed) || globalImageRef.test(trimmed)) return trimmed;
  if (shortFamilyRef.test(trimmed)) return `projects/${imageProject}/global/images/${trimmed}`;
  if (shortImageRef.test(trimmed)) {
    return `projects/${imageProject}/global/${trimmed}`;
  }
  if (familyName.test(trimmed)) return `projects/${imageProject}/global/images/family/${trimmed}`;

  throw new ProviderError(
    'gcp',
    400,
    `GCP image must be an image family name or a Compute Engine image/family reference: ${trimmed}`,
    { category: 'invalid_config' }
  );
}
