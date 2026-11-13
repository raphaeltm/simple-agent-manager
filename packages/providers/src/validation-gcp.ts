import {
  expectObject,
  type JsonObject,
  optionalArray,
  optionalObject,
  optionalString,
  optionalStringRecord,
  requireString,
  validationError,
} from './validation-core';

export interface GcpOperationPayload {
  name?: string;
  status: string;
  error?: { errors?: Array<{ code: string; message: string }> };
}

export interface GcpNetworkInterfacePayload {
  accessConfigs?: Array<{ natIP?: string }>;
}

export interface GcpInstancePayload {
  id: string;
  name: string;
  status: string;
  machineType: string;
  creationTimestamp: string;
  /** Zone URL the instance lives in (`instances` resources always state it). */
  zone?: string;
  labels?: Record<string, string>;
  networkInterfaces?: GcpNetworkInterfacePayload[];
  /** Size of the boot disk in GB (`disks[boot=true].diskSizeGb`), when the response states it. */
  bootDiskSizeGb?: number;
}

export function validateGcpOperation(
  payload: unknown,
  context: string,
  options: { requireName: true }
): GcpOperationPayload & { name: string };
export function validateGcpOperation(
  payload: unknown,
  context: string,
  options?: { requireName?: false }
): GcpOperationPayload;
export function validateGcpOperation(
  payload: unknown,
  context: string,
  options?: { requireName?: boolean }
): GcpOperationPayload {
  const root = expectObject(payload, 'gcp', context);
  const name = optionalString(root, 'name', 'gcp', context);
  if (options?.requireName && !name) {
    throw validationError('gcp', `${context}.name`, 'expected non-empty string');
  }
  const error = optionalGcpOperationError(root, context);
  return {
    ...(name ? { name } : {}),
    status: requireString(root, 'status', 'gcp', context),
    ...(error ? { error } : {}),
  };
}

export function validateGcpInstance(payload: unknown, context: string): GcpInstancePayload {
  const root = expectObject(payload, 'gcp', context);
  const labels = optionalStringRecord(root, 'labels', 'gcp', context);
  const networkInterfaces = optionalGcpNetworkInterfaces(root, context);
  const bootDiskSizeGb = gcpBootDiskSizeGb(root);
  const zone = optionalString(root, 'zone', 'gcp', context);

  return {
    id: requireString(root, 'id', 'gcp', context),
    name: requireString(root, 'name', 'gcp', context),
    status: requireString(root, 'status', 'gcp', context),
    machineType: requireString(root, 'machineType', 'gcp', context),
    creationTimestamp: requireString(root, 'creationTimestamp', 'gcp', context),
    ...(zone ? { zone } : {}),
    ...(labels ? { labels } : {}),
    ...(networkInterfaces ? { networkInterfaces } : {}),
    ...(bootDiskSizeGb !== undefined ? { bootDiskSizeGb } : {}),
  };
}

/**
 * The boot disk's size from `disks[]`. GCP sends `diskSizeGb` as an int64 string. A missing or
 * malformed value is left out rather than rejected: the disk size only feeds observed hardware,
 * and an instance without it must still be listable and deletable.
 */
function gcpBootDiskSizeGb(root: JsonObject): number | undefined {
  const disks = root.disks;
  if (!Array.isArray(disks)) return undefined;
  for (const disk of disks) {
    if (!disk || typeof disk !== 'object' || Array.isArray(disk)) continue;
    if (!('boot' in disk) || disk.boot !== true) continue;
    const raw = 'diskSizeGb' in disk ? disk.diskSizeGb : undefined;
    const size = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? size : undefined;
  }
  return undefined;
}

/** One `items` entry of a GCP aggregated list: a zone's instances, or a warning about it. */
export interface GcpAggregatedScope {
  instances?: GcpInstancePayload[];
  warning?: { code: string; message?: string };
}

export function validateGcpAggregatedInstances(
  payload: unknown,
  context: string
): { items?: Record<string, GcpAggregatedScope>; nextPageToken?: string } {
  const root = expectObject(payload, 'gcp', context);
  const items = optionalObject(root, 'items', 'gcp', context);
  const nextPageToken = optionalString(root, 'nextPageToken', 'gcp', context);
  if (nextPageToken !== undefined && nextPageToken.length === 0) {
    throw validationError('gcp', `${context}.nextPageToken`, 'expected non-empty string');
  }
  if (!items) return { ...(nextPageToken ? { nextPageToken } : {}) };

  const scopes: Record<string, GcpAggregatedScope> = {};
  for (const [scope, scopePayload] of Object.entries(items)) {
    const scopeContext = `${context}.items.${scope}`;
    const scopeObj = expectObject(scopePayload, 'gcp', scopeContext);
    const instances = optionalArray(scopeObj, 'instances', 'gcp', scopeContext);
    const warningObj = optionalObject(scopeObj, 'warning', 'gcp', scopeContext);
    const warning = warningObj
      ? {
          code: requireString(warningObj, 'code', 'gcp', `${scopeContext}.warning`),
          ...(typeof warningObj.message === 'string' ? { message: warningObj.message } : {}),
        }
      : undefined;
    // GCP marks an empty scope with a warning (NO_RESULTS_ON_PAGE). A scope with neither field
    // is malformed; reading it as empty would let orphan reconciliation trust a partial inventory.
    if (!instances && !warning) {
      throw validationError('gcp', scopeContext, 'expected instances or warning');
    }
    scopes[scope] = {
      ...(instances
        ? {
            instances: instances.map((instance, index) =>
              validateGcpInstance(instance, `${scopeContext}.instances[${index}]`)
            ),
          }
        : {}),
      ...(warning ? { warning } : {}),
    };
  }

  return {
    items: scopes,
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}

function optionalGcpOperationError(
  root: JsonObject,
  context: string
): { errors?: Array<{ code: string; message: string }> } | undefined {
  const error = optionalObject(root, 'error', 'gcp', context);
  if (!error) return undefined;
  const errors = optionalArray(error, 'errors', 'gcp', `${context}.error`);
  if (!errors) return {};

  return {
    errors: errors.map((entry, index) => {
      const entryObj = expectObject(entry, 'gcp', `${context}.error.errors[${index}]`);
      return {
        code: requireString(entryObj, 'code', 'gcp', `${context}.error.errors[${index}]`),
        message: requireString(entryObj, 'message', 'gcp', `${context}.error.errors[${index}]`),
      };
    }),
  };
}

function optionalGcpNetworkInterfaces(
  root: JsonObject,
  context: string
): GcpNetworkInterfacePayload[] | undefined {
  const networkInterfaces = optionalArray(root, 'networkInterfaces', 'gcp', context);
  if (!networkInterfaces) return undefined;

  return networkInterfaces.map((networkInterface, index) => {
    const iface = expectObject(networkInterface, 'gcp', `${context}.networkInterfaces[${index}]`);
    const accessConfigs = optionalArray(
      iface,
      'accessConfigs',
      'gcp',
      `${context}.networkInterfaces[${index}]`
    );
    if (!accessConfigs) return {};
    return {
      accessConfigs: accessConfigs.map((accessConfig, configIndex) => {
        const config = expectObject(
          accessConfig,
          'gcp',
          `${context}.networkInterfaces[${index}].accessConfigs[${configIndex}]`
        );
        const natIP = optionalString(
          config,
          'natIP',
          'gcp',
          `${context}.networkInterfaces[${index}].accessConfigs[${configIndex}]`
        );
        return natIP ? { natIP } : {};
      }),
    };
  });
}
