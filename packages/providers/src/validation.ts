import {
  expectObject,
  type JsonObject,
  optionalArray,
  optionalObject,
  optionalString,
  optionalStringRecord,
  requireArray,
  requireNumber,
  requireObject,
  requireString,
  validationError,
} from './validation-core';

export interface HetznerServerPayload {
  id: number;
  name: string;
  status: string;
  public_net: { ipv4: { ip: string } };
  server_type: { name: string };
  created: string;
  labels: Record<string, string>;
}

export interface ScalewayServerPayload {
  id: string;
  name: string;
  state: string;
  public_ip: { address: string } | null;
  public_ips: Array<{ address: string }>;
  commercial_type: string;
  creation_date: string;
  tags: string[];
}

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
  labels?: Record<string, string>;
  networkInterfaces?: GcpNetworkInterfacePayload[];
}

export async function parseProviderJson(
  response: Response,
  providerName: string,
  context: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    throw validationError(
      providerName,
      context,
      'expected valid JSON response body',
      err,
    );
  }
}

export function validateHetznerServerResponse(
  payload: unknown,
  context: string,
): { server: HetznerServerPayload } {
  const root = expectObject(payload, 'hetzner', context);
  return {
    server: validateHetznerServer(
      requireObject(root, 'server', 'hetzner', context),
      `${context}.server`,
    ),
  };
}

export function validateHetznerServersResponse(
  payload: unknown,
  context: string,
): { servers: HetznerServerPayload[] } {
  const root = expectObject(payload, 'hetzner', context);
  const servers = requireArray(root, 'servers', 'hetzner', context);
  return {
    servers: servers.map((server, index) => validateHetznerServer(server, `${context}.servers[${index}]`)),
  };
}

export function validateScalewayServerResponse(
  payload: unknown,
  context: string,
): { server: ScalewayServerPayload } {
  const root = expectObject(payload, 'scaleway', context);
  return {
    server: validateScalewayServer(
      requireObject(root, 'server', 'scaleway', context),
      `${context}.server`,
    ),
  };
}

export function validateScalewayServersResponse(
  payload: unknown,
  context: string,
): { servers: ScalewayServerPayload[] } {
  const root = expectObject(payload, 'scaleway', context);
  const servers = requireArray(root, 'servers', 'scaleway', context);
  return {
    servers: servers.map((server, index) => validateScalewayServer(server, `${context}.servers[${index}]`)),
  };
}

export function validateScalewayImageResponse(
  payload: unknown,
  context: string,
): { images: Array<{ id: string; name: string }> } {
  const root = expectObject(payload, 'scaleway', context);
  const images = requireArray(root, 'images', 'scaleway', context);
  return {
    images: images.map((image, index) => {
      const imageObj = expectObject(image, 'scaleway', `${context}.images[${index}]`);
      return {
        id: requireString(imageObj, 'id', 'scaleway', `${context}.images[${index}]`),
        name: requireString(imageObj, 'name', 'scaleway', `${context}.images[${index}]`),
      };
    }),
  };
}

export function validateGcpOperation(
  payload: unknown,
  context: string,
  options: { requireName: true },
): GcpOperationPayload & { name: string };
export function validateGcpOperation(
  payload: unknown,
  context: string,
  options?: { requireName?: false },
): GcpOperationPayload;
export function validateGcpOperation(
  payload: unknown,
  context: string,
  options?: { requireName?: boolean },
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

  return {
    id: requireString(root, 'id', 'gcp', context),
    name: requireString(root, 'name', 'gcp', context),
    status: requireString(root, 'status', 'gcp', context),
    machineType: requireString(root, 'machineType', 'gcp', context),
    creationTimestamp: requireString(root, 'creationTimestamp', 'gcp', context),
    ...(labels ? { labels } : {}),
    ...(networkInterfaces ? { networkInterfaces } : {}),
  };
}

export function validateGcpInstancesList(
  payload: unknown,
  context: string,
): { items?: GcpInstancePayload[] } {
  const root = expectObject(payload, 'gcp', context);
  const items = optionalArray(root, 'items', 'gcp', context);
  if (!items) return {};
  return {
    items: items.map((instance, index) => validateGcpInstance(instance, `${context}.items[${index}]`)),
  };
}

export function validateGcpAggregatedInstances(
  payload: unknown,
  context: string,
): { items?: Record<string, { instances?: GcpInstancePayload[] }> } {
  const root = expectObject(payload, 'gcp', context);
  const items = optionalObject(root, 'items', 'gcp', context);
  if (!items) return {};

  const scopes: Record<string, { instances?: GcpInstancePayload[] }> = {};
  for (const [scope, scopePayload] of Object.entries(items)) {
    const scopeObj = expectObject(scopePayload, 'gcp', `${context}.items.${scope}`);
    const instances = optionalArray(scopeObj, 'instances', 'gcp', `${context}.items.${scope}`);
    scopes[scope] = instances
      ? { instances: instances.map((instance, index) => validateGcpInstance(instance, `${context}.items.${scope}.instances[${index}]`)) }
      : {};
  }

  return { items: scopes };
}

function validateHetznerServer(payload: unknown, context: string): HetznerServerPayload {
  const server = expectObject(payload, 'hetzner', context);
  const publicNet = requireObject(server, 'public_net', 'hetzner', context);
  const ipv4 = requireObject(publicNet, 'ipv4', 'hetzner', `${context}.public_net`);
  const serverType = requireObject(server, 'server_type', 'hetzner', context);

  return {
    id: requireNumber(server, 'id', 'hetzner', context),
    name: requireString(server, 'name', 'hetzner', context),
    status: requireString(server, 'status', 'hetzner', context),
    public_net: {
      ipv4: {
        ip: requireString(ipv4, 'ip', 'hetzner', `${context}.public_net.ipv4`),
      },
    },
    server_type: {
      name: requireString(serverType, 'name', 'hetzner', `${context}.server_type`),
    },
    created: requireString(server, 'created', 'hetzner', context),
    labels: optionalStringRecord(server, 'labels', 'hetzner', context) ?? {},
  };
}

function validateScalewayServer(payload: unknown, context: string): ScalewayServerPayload {
  const server = expectObject(payload, 'scaleway', context);
  const publicIp = optionalNullableAddress(server, 'public_ip', 'scaleway', context);
  const publicIps = requireArray(server, 'public_ips', 'scaleway', context).map((ip, index) => {
    const ipObj = expectObject(ip, 'scaleway', `${context}.public_ips[${index}]`);
    return { address: requireString(ipObj, 'address', 'scaleway', `${context}.public_ips[${index}]`) };
  });

  return {
    id: requireString(server, 'id', 'scaleway', context),
    name: requireString(server, 'name', 'scaleway', context),
    state: requireString(server, 'state', 'scaleway', context),
    public_ip: publicIp,
    public_ips: publicIps,
    commercial_type: requireString(server, 'commercial_type', 'scaleway', context),
    creation_date: requireString(server, 'creation_date', 'scaleway', context),
    tags: requireStringArray(server, 'tags', 'scaleway', context),
  };
}

function optionalGcpOperationError(
  root: JsonObject,
  context: string,
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
  context: string,
): GcpNetworkInterfacePayload[] | undefined {
  const networkInterfaces = optionalArray(root, 'networkInterfaces', 'gcp', context);
  if (!networkInterfaces) return undefined;

  return networkInterfaces.map((networkInterface, index) => {
    const iface = expectObject(networkInterface, 'gcp', `${context}.networkInterfaces[${index}]`);
    const accessConfigs = optionalArray(iface, 'accessConfigs', 'gcp', `${context}.networkInterfaces[${index}]`);
    if (!accessConfigs) return {};
    return {
      accessConfigs: accessConfigs.map((accessConfig, configIndex) => {
        const config = expectObject(
          accessConfig,
          'gcp',
          `${context}.networkInterfaces[${index}].accessConfigs[${configIndex}]`,
        );
        const natIP = optionalString(config, 'natIP', 'gcp', `${context}.networkInterfaces[${index}].accessConfigs[${configIndex}]`);
        return natIP ? { natIP } : {};
      }),
    };
  });
}

function optionalNullableAddress(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): { address: string } | null {
  const value = root[key];
  if (value === null) return null;
  const obj = expectObject(value, providerName, `${context}.${key}`);
  return { address: requireString(obj, 'address', providerName, `${context}.${key}`) };
}

function requireStringArray(
  root: JsonObject,
  key: string,
  providerName: string,
  context: string,
): string[] {
  return requireArray(root, key, providerName, context).map((value, index) => {
    if (typeof value !== 'string') {
      throw validationError(providerName, `${context}.${key}[${index}]`, 'expected string');
    }
    return value;
  });
}
