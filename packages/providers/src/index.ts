import { GcpProvider } from './gcp';
import { HetznerProvider } from './hetzner';
import { ScalewayProvider } from './scaleway';
import type { Provider, ProviderConfig } from './types';
import { ProviderError } from './types';
import { VultrProvider } from './vultr';

// Re-export types
export type {
  GcpProviderConfig,
  HetznerProviderConfig,
  LocationMeta,
  Provider,
  ProviderConfig,
  ProviderErrorCategory,
  ProviderErrorContext,
  ProviderErrorContextValue,
  ProviderLogContext,
  ProviderLogger,
  ScalewayProviderConfig,
  SizeConfig,
  VMConfig,
  VMInstance,
  VMStatus,
  VolumeAttachmentConfig,
  VolumeCapabilities,
  VolumeConfig,
  VolumeDetachConfig,
  VolumeInstance,
  VolumeLifecycleConventions,
  VolumeListConfig,
  VolumeLookupConfig,
  VolumeResizeConfig,
  VolumeStatus,
  VultrProviderConfig,
} from './types';
export {
  ProviderError,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';

// Re-export utilities
export { getMaxProviderErrorBodyChars, getTimeoutMs, providerFetch } from './provider-fetch';

// Re-export providers and classification functions
export type { GcpTokenProvider } from './gcp';
export {
  classifyGcpError,
  DEFAULT_GCP_AGENT_PORTS,
  DEFAULT_GCP_APP_ROUTE_PORTS,
  DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES,
  DEFAULT_GCP_FIREWALL_SOURCE_RANGES,
  GCP_LOCATIONS,
  GcpProvider,
} from './gcp';
export type { HetznerProviderRuntimeOptions } from './hetzner';
export {
  classifyHetznerError,
  DEFAULT_CAPACITY_RETRY_BUDGET_MS,
  DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS,
  DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS,
  DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS,
  DEFAULT_PLACEMENT_RETRY_DELAY_MS,
  HETZNER_MAX_VOLUMES_PER_SERVER,
  HETZNER_VOLUME_MAX_SIZE_GB,
  HETZNER_VOLUME_MIN_SIZE_GB,
  HetznerProvider,
  isTransientCapacityError,
} from './hetzner';
export { classifyScalewayError, SCALEWAY_LOCATIONS, ScalewayProvider } from './scaleway';
export {
  SCALEWAY_DEFAULT_VOLUME_IOPS,
  SCALEWAY_MAX_VOLUMES_PER_SERVER,
  SCALEWAY_VOLUME_MAX_SIZE_GB,
  SCALEWAY_VOLUME_MIN_SIZE_GB,
} from './scaleway-volumes';
export type { VultrProviderRuntimeOptions } from './vultr';
export {
  classifyVultrError,
  DEFAULT_VULTR_IP_POLL_INTERVAL_MS,
  DEFAULT_VULTR_IP_POLL_TIMEOUT_MS,
  DEFAULT_VULTR_REQUEST_TIMEOUT_MS,
  findVultrOs,
  mapVultrStatus,
  VULTR_LOCATIONS,
  VultrProvider,
} from './vultr';
export { VULTR_VOLUME_MAX_SIZE_GB, VULTR_VOLUME_MIN_SIZE_GB } from './vultr-volumes';

/**
 * Create a provider instance from explicit configuration.
 * MUST NOT access process.env or any Node.js-only APIs.
 */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.provider) {
    case 'hetzner':
      return new HetznerProvider(
        config.apiToken,
        config.datacenter,
        config.placementRetryDelayMs,
        config.placementFallbackEnabled,
        config.capacityRetryInitialDelayMs,
        config.capacityRetryMaxDelayMs,
        {
          capacityRetryMaxAttempts: config.capacityRetryMaxAttempts,
          capacityRetryBudgetMs: config.capacityRetryBudgetMs,
          logger: config.logger,
        }
      );
    case 'scaleway':
      return new ScalewayProvider(config.secretKey, config.projectId, config.zone);
    case 'vultr':
      return new VultrProvider(config.apiToken, {
        region: config.region,
        osName: config.osName,
        requestTimeoutMs: config.requestTimeoutMs,
        ipPollTimeoutMs: config.ipPollTimeoutMs,
        ipPollIntervalMs: config.ipPollIntervalMs,
        logger: config.logger,
      });
    case 'gcp':
      return new GcpProvider(
        config.projectId,
        config.tokenProvider,
        config.defaultZone,
        config.imageFamily,
        config.imageProject,
        config.diskSizeGb,
        config.timeoutMs,
        config.operationPollTimeoutMs,
        config.firewallSourceRanges,
        config.agentPorts,
        config.appRouteSourceRanges,
        config.appRoutePorts
      );
    default: {
      const _exhaustive: never = config;
      throw new ProviderError(
        'factory',
        undefined,
        `Unsupported provider: ${(_exhaustive as { provider: string }).provider}`
      );
    }
  }
}
