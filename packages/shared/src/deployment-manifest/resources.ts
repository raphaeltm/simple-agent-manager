import { RESOURCE_RESERVATION_VERSION } from '../constants/resource-defaults';
import type { ResolvedResourceReservation } from '../types/resource';
export interface DeploymentReservationManifest {
  services: Record<string, { resources?: { memoryLimitMb: number; cpuLimit: number } }>;
  volumes: Record<string, { sizeHintMb?: number }>;
}

/** Conservative reservation used when a service omits explicit limits. */
export const DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS = 250;
export const DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB = 256;
/** Root-filesystem allowance per service for image layers, logs, and temporary files. */
export const DEFAULT_DEPLOYMENT_SERVICE_DISK_MB = 1_024;

export interface DeploymentReservationDefaults {
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
}

const DEFAULT_DEPLOYMENT_RESERVATION_DEFAULTS: DeploymentReservationDefaults = {
  cpuMillis: DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS,
  memoryMb: DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB,
  diskMb: DEFAULT_DEPLOYMENT_SERVICE_DISK_MB,
};

/**
 * Convert one normalized manifest into the exact scheduler reservation used for
 * deployment-node selection and admission.
 *
 * Service CPU and memory limits are additive because services may run at the
 * same time. Named-volume size hints are additive disk commitments. A manifest
 * with persistent volumes remains exclusive even when its numeric reservation
 * would otherwise fit on a shared node.
 */
export function resolveDeploymentManifestReservation(
  manifest: DeploymentReservationManifest,
  environmentId: string,
  defaults: DeploymentReservationDefaults = DEFAULT_DEPLOYMENT_RESERVATION_DEFAULTS
): ResolvedResourceReservation {
  let cpuMillis = 0;
  let memoryMb = 0;
  let diskMb = 0;

  for (const service of Object.values(manifest.services)) {
    cpuMillis += service.resources
      ? Math.ceil(service.resources.cpuLimit * 1_000)
      : defaults.cpuMillis;
    memoryMb += service.resources?.memoryLimitMb ?? defaults.memoryMb;
    diskMb += defaults.diskMb;
  }

  for (const volume of Object.values(manifest.volumes)) {
    diskMb += volume.sizeHintMb ?? 0;
  }

  const usesDefaults = Object.values(manifest.services).some((service) => !service.resources);
  return {
    cpuMillis,
    memoryMb,
    diskMb,
    exclusiveNode: Object.keys(manifest.volumes).length > 0,
    source: 'task',
    sourceId: environmentId,
    version: RESOURCE_RESERVATION_VERSION,
    diagnostics: [
      'deployment-manifest-reservation:v1',
      ...(usesDefaults ? ['deployment-service-resource-defaults-applied'] : []),
    ],
  };
}
