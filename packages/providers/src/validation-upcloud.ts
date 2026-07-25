import {
  expectObject,
  optionalArray,
  optionalString,
  requireArray,
  requireNumber,
  requireString,
  validationError,
} from './validation-core';
export interface UpCloudLabel {
  key: string;
  value: string;
}
export interface UpCloudServer {
  uuid: string;
  title: string;
  hostname: string;
  state: string;
  zone: string;
  plan: string;
  created: string;
  labels: UpCloudLabel[];
  ipAddresses: Array<{ access: string; address: string; family: string }>;
  storageDevices: Array<{ address: string; storage: string; title: string; bootDisk: string }>;
}
export interface UpCloudZone {
  id: string;
}
export interface UpCloudPlan {
  name: string;
}
export interface UpCloudStorage {
  uuid: string;
  title: string;
  size: number;
  state: string;
  zone: string;
  tier: string;
  type: string;
  created: string;
  templateType: string;
  labels: UpCloudLabel[];
  servers: string[];
}
export function validateUpCloudAccountResponse(payload: unknown, context: string) {
  expectObject(expectObject(payload, 'upcloud', context).account, 'upcloud', `${context}.account`);
}
export function validateUpCloudServerResponse(payload: unknown, context: string) {
  const root = expectObject(payload, 'upcloud', context);
  return server(expectObject(root.server, 'upcloud', context), context);
}
export function validateUpCloudServersResponse(payload: unknown, context: string) {
  const root = expectObject(expectObject(payload, 'upcloud', context).servers, 'upcloud', context);
  return requireArray(root, 'server', 'upcloud', context).map((v, i) =>
    server(expectObject(v, 'upcloud', `${context}[${i}]`), context)
  );
}
export function validateUpCloudZonesResponse(payload: unknown, context: string): UpCloudZone[] {
  const root = expectObject(expectObject(payload, 'upcloud', context).zones, 'upcloud', context);
  return requireArray(root, 'zone', 'upcloud', context).map((value, index) => {
    const zone = expectObject(value, 'upcloud', context + '[' + index + ']');
    return { id: requireString(zone, 'id', 'upcloud', context + '[' + index + ']') };
  });
}
export function validateUpCloudPlansResponse(payload: unknown, context: string): UpCloudPlan[] {
  const root = expectObject(expectObject(payload, 'upcloud', context).plans, 'upcloud', context);
  return requireArray(root, 'plan', 'upcloud', context).map((value, index) => {
    const plan = expectObject(value, 'upcloud', context + '[' + index + ']');
    return { name: requireString(plan, 'name', 'upcloud', context + '[' + index + ']') };
  });
}
export function validateUpCloudStorageResponse(payload: unknown, context: string) {
  const root = expectObject(payload, 'upcloud', context);
  return storage(expectObject(root.storage, 'upcloud', context), context);
}
export function validateUpCloudStoragesResponse(payload: unknown, context: string) {
  const root = expectObject(expectObject(payload, 'upcloud', context).storages, 'upcloud', context);
  return requireArray(root, 'storage', 'upcloud', context).map((v, i) =>
    storage(expectObject(v, 'upcloud', `${context}[${i}]`), context)
  );
}
function labels(v: unknown, c: string): UpCloudLabel[] {
  const a = Array.isArray(v)
    ? v
    : v && typeof v === 'object'
      ? (optionalArray(v as Record<string, unknown>, 'label', 'upcloud', c) ?? [])
      : [];
  return a.map((x) => {
    const o = expectObject(x, 'upcloud', c);
    return {
      key: requireString(o, 'key', 'upcloud', c),
      value: requireString(o, 'value', 'upcloud', c),
    };
  });
}
function server(o: Record<string, unknown>, c: string): UpCloudServer {
  const ips = expectObject(o.ip_addresses ?? { ip_address: [] }, 'upcloud', c),
    dev = expectObject(o.storage_devices ?? { storage_device: [] }, 'upcloud', c);
  return {
    uuid: requireString(o, 'uuid', 'upcloud', c),
    title: optionalString(o, 'title', 'upcloud', c) ?? '',
    hostname: optionalString(o, 'hostname', 'upcloud', c) ?? '',
    state: requireString(o, 'state', 'upcloud', c),
    zone: requireString(o, 'zone', 'upcloud', c),
    plan: optionalString(o, 'plan', 'upcloud', c) ?? 'custom',
    created: optionalString(o, 'created', 'upcloud', c) ?? '',
    labels: labels(o.labels, c),
    ipAddresses: (optionalArray(ips, 'ip_address', 'upcloud', c) ?? []).map((x) => {
      const p = expectObject(x, 'upcloud', c);
      return {
        access: requireString(p, 'access', 'upcloud', c),
        address: requireString(p, 'address', 'upcloud', c),
        family: requireString(p, 'family', 'upcloud', c),
      };
    }),
    storageDevices: (optionalArray(dev, 'storage_device', 'upcloud', c) ?? []).map((x) => {
      const d = expectObject(x, 'upcloud', c);
      return {
        address: optionalString(d, 'address', 'upcloud', c) ?? '',
        storage: requireString(d, 'storage', 'upcloud', c),
        title: optionalString(d, 'storage_title', 'upcloud', c) ?? '',
        bootDisk: String(d.boot_disk ?? ''),
      };
    }),
  };
}
function storage(o: Record<string, unknown>, c: string): UpCloudStorage {
  const sr = expectObject(o.servers ?? { server: [] }, 'upcloud', c);
  const size =
    typeof o.size === 'number'
      ? requireNumber(o, 'size', 'upcloud', c)
      : Number(requireString(o, 'size', 'upcloud', c));
  if (!Number.isFinite(size))
    throw validationError('upcloud', c + '.size', 'expected finite number');
  return {
    uuid: requireString(o, 'uuid', 'upcloud', c),
    title: requireString(o, 'title', 'upcloud', c),
    size,
    state: optionalString(o, 'state', 'upcloud', c) ?? '',
    zone: optionalString(o, 'zone', 'upcloud', c) ?? '',
    tier: optionalString(o, 'tier', 'upcloud', c) ?? '',
    type: optionalString(o, 'type', 'upcloud', c) ?? '',
    created: optionalString(o, 'created', 'upcloud', c) ?? '',
    templateType: optionalString(o, 'template_type', 'upcloud', c) ?? '',
    labels: labels(o.labels, c),
    servers: (optionalArray(sr, 'server', 'upcloud', c) ?? []).filter(
      (x): x is string => typeof x === 'string'
    ),
  };
}
