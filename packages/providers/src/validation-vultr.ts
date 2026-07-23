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

// Vultr API v2 response payloads (https://api.vultr.com/v2). Field names match the
// live API. Optional/empty-tolerant fields (main_ip="0.0.0.0", label="", mount_id="",
// power_status/server_status absent while pending) use optional parsing so a valid
// but partially-populated instance/block never fails validation.

export interface VultrInstancePayload {
  id: string;
  main_ip: string;
  status: string;
  power_status: string;
  server_status: string;
  region: string;
  plan: string;
  date_created: string;
  label: string;
  tags: string[];
}

export interface VultrOsPayload {
  id: number;
  name: string;
  arch: string;
  family: string;
}

export interface VultrBlockPayload {
  id: string;
  region: string;
  size_gb: number;
  label: string;
  block_type: string;
  status: string;
  attached_to_instance: string;
  mount_id: string;
  date_created: string;
}

export function validateVultrInstanceResponse(
  payload: unknown,
  context: string,
): { instance: VultrInstancePayload } {
  const root = expectObject(payload, 'vultr', context);
  return {
    instance: validateVultrInstance(
      requireObjectField(root, 'instance', context),
      `${context}.instance`,
    ),
  };
}

export function validateVultrInstancesResponse(
  payload: unknown,
  context: string,
): { instances: VultrInstancePayload[]; nextCursor?: string } {
  const root = expectObject(payload, 'vultr', context);
  const instances = requireArray(root, 'instances', 'vultr', context).map((instance, index) =>
    validateVultrInstance(instance, `${context}.instances[${index}]`),
  );
  const nextCursor = extractNextCursor(root);
  return nextCursor ? { instances, nextCursor } : { instances };
}

export function validateVultrOsResponse(
  payload: unknown,
  context: string,
): { os: VultrOsPayload[]; nextCursor?: string } {
  const root = expectObject(payload, 'vultr', context);
  const os = requireArray(root, 'os', 'vultr', context).map((entry, index) => {
    const obj = expectObject(entry, 'vultr', `${context}.os[${index}]`);
    return {
      id: requireNumber(obj, 'id', 'vultr', `${context}.os[${index}]`),
      name: requireString(obj, 'name', 'vultr', `${context}.os[${index}]`),
      arch: optionalString(obj, 'arch', 'vultr', `${context}.os[${index}]`) ?? '',
      family: optionalString(obj, 'family', 'vultr', `${context}.os[${index}]`) ?? '',
    };
  });
  const nextCursor = extractNextCursor(root);
  return nextCursor ? { os, nextCursor } : { os };
}

export function validateVultrBlockResponse(
  payload: unknown,
  context: string,
): { block: VultrBlockPayload } {
  const root = expectObject(payload, 'vultr', context);
  return {
    block: validateVultrBlock(requireObjectField(root, 'block', context), `${context}.block`),
  };
}

export function validateVultrBlocksResponse(
  payload: unknown,
  context: string,
): { blocks: VultrBlockPayload[]; nextCursor?: string } {
  const root = expectObject(payload, 'vultr', context);
  const blocks = requireArray(root, 'blocks', 'vultr', context).map((block, index) =>
    validateVultrBlock(block, `${context}.blocks[${index}]`),
  );
  const nextCursor = extractNextCursor(root);
  return nextCursor ? { blocks, nextCursor } : { blocks };
}

function validateVultrInstance(payload: unknown, context: string): VultrInstancePayload {
  const inst = expectObject(payload, 'vultr', context);
  return {
    id: requireString(inst, 'id', 'vultr', context),
    main_ip: optionalString(inst, 'main_ip', 'vultr', context) ?? '',
    status: requireString(inst, 'status', 'vultr', context),
    power_status: optionalString(inst, 'power_status', 'vultr', context) ?? '',
    server_status: optionalString(inst, 'server_status', 'vultr', context) ?? '',
    region: requireString(inst, 'region', 'vultr', context),
    plan: requireString(inst, 'plan', 'vultr', context),
    date_created: requireString(inst, 'date_created', 'vultr', context),
    label: optionalString(inst, 'label', 'vultr', context) ?? '',
    tags: optionalStringArray(inst, 'tags', 'vultr', context),
  };
}

function validateVultrBlock(payload: unknown, context: string): VultrBlockPayload {
  const block = expectObject(payload, 'vultr', context);
  return {
    id: requireString(block, 'id', 'vultr', context),
    region: requireString(block, 'region', 'vultr', context),
    size_gb: requireNumber(block, 'size_gb', 'vultr', context),
    label: optionalString(block, 'label', 'vultr', context) ?? '',
    block_type: optionalString(block, 'block_type', 'vultr', context) ?? '',
    status: optionalString(block, 'status', 'vultr', context) ?? '',
    attached_to_instance: optionalString(block, 'attached_to_instance', 'vultr', context) ?? '',
    mount_id: optionalString(block, 'mount_id', 'vultr', context) ?? '',
    date_created: requireString(block, 'date_created', 'vultr', context),
  };
}

function requireObjectField(root: JsonObject, key: string, context: string): JsonObject {
  const value = root[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('vultr', `${context}.${key}`, 'expected object');
  }
  return value as JsonObject;
}

function optionalStringArray(root: JsonObject, key: string, providerName: string, context: string): string[] {
  const value = root[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw validationError(providerName, `${context}.${key}`, 'expected array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw validationError(providerName, `${context}.${key}[${index}]`, 'expected string');
    }
    return entry;
  });
}

function extractNextCursor(root: JsonObject): string | undefined {
  const meta = optionalObject(root, 'meta', 'vultr', 'meta');
  if (!meta) return undefined;
  const links = optionalObject(meta, 'links', 'vultr', 'meta.links');
  if (!links) return undefined;
  const next = optionalString(links, 'next', 'vultr', 'meta.links');
  return next && next.length > 0 ? next : undefined;
}
