import {
  expectObject,
  type JsonObject,
  optionalObject,
  optionalString,
  requireArray,
  requireNumber,
  requireString,
  validationError,
} from './validation-core';

// DigitalOcean API v2 response payloads (https://api.digitalocean.com/v2). Field names
// match the live API. Droplet ids are INTEGERS (converted to string by the mapper).
// Fields that are empty/absent while a droplet provisions (networks.v4 empty until
// active, size_slug present, tags absent) use optional parsing so a valid but
// partially-populated droplet/volume never fails validation.

const PROVIDER = 'digitalocean';

export interface DigitalOceanNetworkV4 {
  ip_address: string;
  type: string;
}

export interface DigitalOceanDropletPayload {
  id: number;
  name: string;
  status: string;
  size_slug: string;
  created_at: string;
  networks_v4: DigitalOceanNetworkV4[];
  tags: string[];
}

export interface DigitalOceanVolumePayload {
  id: string;
  name: string;
  size_gigabytes: number;
  region_slug: string;
  droplet_ids: number[];
  created_at: string;
  tags: string[];
}

export interface DigitalOceanActionPayload {
  id: number;
  status: string;
  type: string;
}

export function validateDigitalOceanDropletResponse(
  payload: unknown,
  context: string,
): { droplet: DigitalOceanDropletPayload } {
  const root = expectObject(payload, PROVIDER, context);
  return {
    droplet: validateDroplet(requireObjectField(root, 'droplet', context), `${context}.droplet`),
  };
}

export function validateDigitalOceanDropletsResponse(
  payload: unknown,
  context: string,
): { droplets: DigitalOceanDropletPayload[]; hasNextPage: boolean } {
  const root = expectObject(payload, PROVIDER, context);
  const droplets = requireArray(root, 'droplets', PROVIDER, context).map((droplet, index) =>
    validateDroplet(droplet, `${context}.droplets[${index}]`),
  );
  return { droplets, hasNextPage: hasNextPage(root) };
}

export function validateDigitalOceanVolumeResponse(
  payload: unknown,
  context: string,
): { volume: DigitalOceanVolumePayload } {
  const root = expectObject(payload, PROVIDER, context);
  return {
    volume: validateVolume(requireObjectField(root, 'volume', context), `${context}.volume`),
  };
}

export function validateDigitalOceanVolumesResponse(
  payload: unknown,
  context: string,
): { volumes: DigitalOceanVolumePayload[]; hasNextPage: boolean } {
  const root = expectObject(payload, PROVIDER, context);
  const volumes = requireArray(root, 'volumes', PROVIDER, context).map((volume, index) =>
    validateVolume(volume, `${context}.volumes[${index}]`),
  );
  return { volumes, hasNextPage: hasNextPage(root) };
}

export function validateDigitalOceanActionResponse(
  payload: unknown,
  context: string,
): { action: DigitalOceanActionPayload } {
  const root = expectObject(payload, PROVIDER, context);
  const action = expectObject(requireObjectField(root, 'action', context), PROVIDER, `${context}.action`);
  return {
    action: {
      id: requireNumber(action, 'id', PROVIDER, `${context}.action`),
      status: requireString(action, 'status', PROVIDER, `${context}.action`),
      type: optionalString(action, 'type', PROVIDER, `${context}.action`) ?? '',
    },
  };
}

function validateDroplet(payload: unknown, context: string): DigitalOceanDropletPayload {
  const droplet = expectObject(payload, PROVIDER, context);
  return {
    id: requireNumber(droplet, 'id', PROVIDER, context),
    name: optionalString(droplet, 'name', PROVIDER, context) ?? '',
    status: requireString(droplet, 'status', PROVIDER, context),
    size_slug: optionalString(droplet, 'size_slug', PROVIDER, context) ?? '',
    created_at: optionalString(droplet, 'created_at', PROVIDER, context) ?? '',
    networks_v4: extractNetworksV4(droplet, context),
    tags: optionalStringArray(droplet, 'tags', context),
  };
}

function validateVolume(payload: unknown, context: string): DigitalOceanVolumePayload {
  const volume = expectObject(payload, PROVIDER, context);
  const region = optionalObject(volume, 'region', PROVIDER, context);
  return {
    id: requireString(volume, 'id', PROVIDER, context),
    name: optionalString(volume, 'name', PROVIDER, context) ?? '',
    size_gigabytes: requireNumber(volume, 'size_gigabytes', PROVIDER, context),
    region_slug: region ? optionalString(region, 'slug', PROVIDER, `${context}.region`) ?? '' : '',
    droplet_ids: optionalNumberArray(volume, 'droplet_ids', context),
    created_at: optionalString(volume, 'created_at', PROVIDER, context) ?? '',
    tags: optionalStringArray(volume, 'tags', context),
  };
}

/** Extract `networks.v4[]` (empty while a droplet provisions). */
function extractNetworksV4(droplet: JsonObject, context: string): DigitalOceanNetworkV4[] {
  const networks = optionalObject(droplet, 'networks', PROVIDER, context);
  if (!networks) return [];
  const v4 = networks.v4;
  if (v4 === undefined || v4 === null) return [];
  if (!Array.isArray(v4)) {
    throw validationError(PROVIDER, `${context}.networks.v4`, 'expected array');
  }
  return v4.map((entry, index) => {
    const obj = expectObject(entry, PROVIDER, `${context}.networks.v4[${index}]`);
    return {
      ip_address: optionalString(obj, 'ip_address', PROVIDER, `${context}.networks.v4[${index}]`) ?? '',
      type: optionalString(obj, 'type', PROVIDER, `${context}.networks.v4[${index}]`) ?? '',
    };
  });
}

/** DigitalOcean paginates via `links.pages.next` (a URL present only when more pages remain). */
function hasNextPage(root: JsonObject): boolean {
  const links = optionalObject(root, 'links', PROVIDER, 'links');
  if (!links) return false;
  const pages = optionalObject(links, 'pages', PROVIDER, 'links.pages');
  if (!pages) return false;
  const next = optionalString(pages, 'next', PROVIDER, 'links.pages');
  return typeof next === 'string' && next.length > 0;
}

function requireObjectField(root: JsonObject, key: string, context: string): JsonObject {
  const value = root[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(PROVIDER, `${context}.${key}`, 'expected object');
  }
  return value as JsonObject;
}

function optionalStringArray(root: JsonObject, key: string, context: string): string[] {
  const value = root[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw validationError(PROVIDER, `${context}.${key}`, 'expected array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw validationError(PROVIDER, `${context}.${key}[${index}]`, 'expected string');
    }
    return entry;
  });
}

function optionalNumberArray(root: JsonObject, key: string, context: string): number[] {
  const value = root[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw validationError(PROVIDER, `${context}.${key}`, 'expected array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw validationError(PROVIDER, `${context}.${key}[${index}]`, 'expected number');
    }
    return entry;
  });
}
