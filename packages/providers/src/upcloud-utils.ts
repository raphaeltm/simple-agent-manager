import { AMBIGUOUS_LABEL_MARKER_PREFIX } from './kv-tags';
import type { ProviderErrorCategory, VMInstance, VMStatus, VolumeInstance } from './types';
import { ProviderError } from './types';
import type { UpCloudLabel, UpCloudServer, UpCloudStorage } from './validation-upcloud';

export function classifyUpCloudError(
  status?: number,
  message = '',
  code?: string
): ProviderErrorCategory {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limited';
  if (status === 402 || /LIMIT_REACHED|QUOTA/i.test(code ?? '')) return 'quota_exceeded';
  if (status === 409 && /RESOURCES_UNAVAILABLE|capacity/i.test(code + ' ' + message))
    return 'transient_capacity';
  if (status === 400 || status === 404 || status === 409) return 'invalid_config';
  return 'unknown';
}

export function mapUpCloudStatus(state: string): VMStatus {
  return state === 'started' ? 'running' : state === 'stopped' ? 'off' : 'initializing';
}

export function toUpCloudVM(server: UpCloudServer): VMInstance {
  return {
    id: server.uuid,
    name: server.title || server.hostname,
    ip: publicUpCloudIPv4(server),
    status:
      server.state === 'started' ? 'running' : server.state === 'stopped' ? 'off' : 'initializing',
    serverType: server.plan,
    createdAt: server.created,
    labels: fromUpCloudLabels(server.labels),
  };
}

export function toUpCloudVolume(storage: UpCloudStorage): VolumeInstance {
  return {
    id: storage.uuid,
    name: storage.title,
    sizeGb: storage.size,
    location: storage.zone,
    status: storage.servers.length
      ? 'attached'
      : storage.state === 'online'
        ? 'available'
        : storage.state === 'maintenance'
          ? 'creating'
          : 'unknown',
    attachedServerId: storage.servers[0],
    volumeType: storage.tier,
    createdAt: storage.created,
    labels: fromUpCloudLabels(storage.labels),
  };
}

export function toUpCloudLabels(labels?: Record<string, string>) {
  return Object.entries(labels ?? {}).map(([key, value]) => ({ key, value }));
}

export function fromUpCloudLabels(labels: UpCloudLabel[]) {
  const decoded: Record<string, string> = {};
  const ambiguousKeys = new Set<string>();
  for (const label of labels) {
    if (ambiguousKeys.has(label.key)) continue;
    if (Object.hasOwn(decoded, label.key)) {
      delete decoded[label.key];
      ambiguousKeys.add(label.key);
      decoded[`${AMBIGUOUS_LABEL_MARKER_PREFIX}${label.key}`] = 'true';
      continue;
    }
    decoded[label.key] = label.value;
  }
  return decoded;
}

export function matchesUpCloudLabels(actual: UpCloudLabel[], expected?: Record<string, string>) {
  const map = fromUpCloudLabels(actual);
  return Object.entries(expected ?? {}).every(([key, value]) => map[key] === value);
}

export function publicUpCloudIPv4(server: UpCloudServer) {
  return (
    server.ipAddresses.find((ip) => ip.access === 'public' && ip.family === 'IPv4')?.address ?? ''
  );
}

export function upCloudDevicePath(address?: string) {
  const match = /^virtio:(\d+)$/.exec(address ?? '');
  return match ? `/dev/vd${String.fromCharCode(97 + Number(match[1]))}` : undefined;
}

export function sanitizeUpCloudHostname(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
      .replace(/-+$/, '') || 'sam-node'
  );
}

export function assertUpCloudVolumeSize(size: number, min: number, max: number) {
  if (!Number.isInteger(size) || size < min || size > max) {
    throw new ProviderError('upcloud', 400, `UpCloud storage size must be ${min}-${max} GB`, {
      category: 'invalid_config',
    });
  }
}

export function isUpCloudNotFound(error: unknown) {
  return error instanceof ProviderError && error.statusCode === 404;
}

export function upCloudDelay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function upCloudBasicAuth(username: string, password: string) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
