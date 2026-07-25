import { DigitalOceanProvider } from './digitalocean';
import { GcpProvider } from './gcp';
import { HetznerProvider } from './hetzner';
import { InfomaniakProvider } from './infomaniak';
import { ScalewayProvider } from './scaleway';
import type { Provider, ProviderConfig } from './types';
import { ProviderError } from './types';
import { UpCloudProvider } from './upcloud';
import { VultrProvider } from './vultr';

// Re-export types
export type {
  DigitalOceanProviderConfig,
  GcpProviderConfig,
  HetznerProviderConfig,
  InfomaniakProviderConfig,
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
  UpCloudProviderConfig,
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
export type { DigitalOceanProviderRuntimeOptions } from './digitalocean';
export {
  classifyDigitalOceanError,
  DEFAULT_DIGITALOCEAN_IP_POLL_INTERVAL_MS,
  DEFAULT_DIGITALOCEAN_IP_POLL_TIMEOUT_MS,
  DEFAULT_DIGITALOCEAN_REQUEST_TIMEOUT_MS,
  DIGITALOCEAN_LOCATIONS,
  DigitalOceanProvider,
  extractPublicIp,
  mapDigitalOceanStatus,
} from './digitalocean';
export {
  DEFAULT_DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS,
  DIGITALOCEAN_VOLUME_MAX_SIZE_GB,
  DIGITALOCEAN_VOLUME_MIN_SIZE_GB,
} from './digitalocean-volumes';
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
export {
  classifyInfomaniakError,
  DEFAULT_INFOMANIAK_AUTH_URL,
  DEFAULT_INFOMANIAK_IMAGE_NAME,
  DEFAULT_INFOMANIAK_IP_POLL_INTERVAL_MS,
  DEFAULT_INFOMANIAK_IP_POLL_TIMEOUT_MS,
  DEFAULT_INFOMANIAK_NETWORK_NAME,
  DEFAULT_INFOMANIAK_REGION,
  DEFAULT_INFOMANIAK_REQUEST_TIMEOUT_MS,
  DEFAULT_INFOMANIAK_VOLUME_TYPE,
  INFOMANIAK_LOCATIONS,
  INFOMANIAK_VOLUME_CAPABILITIES,
  INFOMANIAK_VOLUME_MAX_SIZE_GB,
  INFOMANIAK_VOLUME_MIN_SIZE_GB,
  InfomaniakProvider,
  mapInfomaniakStatus,
} from './infomaniak';
export { classifyScalewayError, SCALEWAY_LOCATIONS, ScalewayProvider } from './scaleway';
export {
  SCALEWAY_DEFAULT_VOLUME_IOPS,
  SCALEWAY_MAX_VOLUMES_PER_SERVER,
  SCALEWAY_VOLUME_MAX_SIZE_GB,
  SCALEWAY_VOLUME_MIN_SIZE_GB,
} from './scaleway-volumes';
export type { UpCloudProviderRuntimeOptions } from './upcloud';
export {
  classifyUpCloudError,
  DEFAULT_UPCLOUD_IMAGE_TITLE,
  DEFAULT_UPCLOUD_IP_POLL_INTERVAL_MS,
  DEFAULT_UPCLOUD_IP_POLL_TIMEOUT_MS,
  DEFAULT_UPCLOUD_REQUEST_TIMEOUT_MS,
  DEFAULT_UPCLOUD_STOP_TIMEOUT_SECONDS,
  DEFAULT_UPCLOUD_ZONE,
  mapUpCloudStatus,
  UPCLOUD_LOCATIONS,
  UPCLOUD_VOLUME_MAX_SIZE_GB,
  UPCLOUD_VOLUME_MIN_SIZE_GB,
  UpCloudProvider,
} from './upcloud';
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
    case 'infomaniak':
      return new InfomaniakProvider(
        config.applicationCredentialId,
        config.applicationCredentialSecret,
        {
          authUrl: config.authUrl,
          region: config.region,
          endpointInterface: config.endpointInterface,
          networkName: config.networkName,
          imageName: config.imageName,
          volumeType: config.volumeType,
          flavors: config.flavors,
          requestTimeoutMs: config.requestTimeoutMs,
          ipPollTimeoutMs: config.ipPollTimeoutMs,
          ipPollIntervalMs: config.ipPollIntervalMs,
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
    case 'digitalocean':
      return new DigitalOceanProvider(config.apiToken, {
        region: config.region,
        image: config.image,
        requestTimeoutMs: config.requestTimeoutMs,
        ipPollTimeoutMs: config.ipPollTimeoutMs,
        ipPollIntervalMs: config.ipPollIntervalMs,
        actionPollTimeoutMs: config.actionPollTimeoutMs,
        actionPollIntervalMs: config.actionPollIntervalMs,
        maxListPages: config.maxListPages,
        logger: config.logger,
      });
    case 'upcloud':
      return new UpCloudProvider(config.username, config.password, {
        apiUrl: config.apiUrl,
        zone: config.zone,
        imageTitle: config.imageTitle,
        requestTimeoutMs: config.requestTimeoutMs,
        ipPollTimeoutMs: config.ipPollTimeoutMs,
        ipPollIntervalMs: config.ipPollIntervalMs,
        stopTimeoutSeconds: config.stopTimeoutSeconds,
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
