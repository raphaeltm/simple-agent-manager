import { extractIp, mapGcpStatus } from './gcp-metadata';
import { observedHardware } from './native-vm-config';
import { ProviderError, type VMInstance } from './types';
import type { GcpInstancePayload } from './validation';

export function gcpInstanceToVM(instance: GcpInstancePayload): VMInstance {
  const machineType = instance.machineType.split('/').pop() || instance.machineType;
  return {
    id: instance.id || instance.name,
    name: instance.name,
    ip: extractIp(instance.networkInterfaces),
    status: mapGcpStatus(instance.status),
    serverType: machineType,
    observedHardware: observedHardware({
      serverType: machineType,
      unknownResourcesReason: 'GCP instance response does not include machine resources',
    }),
    createdAt: instance.creationTimestamp,
    labels: instance.labels || {},
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
