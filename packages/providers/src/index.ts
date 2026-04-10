import { GcpProvider } from './gcp';
import { HetznerProvider } from './hetzner';
import { ScalewayProvider } from './scaleway';
import type { Provider, ProviderConfig } from './types';
import { ProviderError } from './types';

// Re-export types
export type {
  GcpProviderConfig,
  HetznerProviderConfig,
  LocationMeta,
  Provider,
  ProviderConfig,
  ScalewayProviderConfig,
  SizeConfig,
  VMConfig,
  VMInstance,
  VMStatus,
} from './types';
export { ProviderError } from './types';

// Re-export utilities
export { getTimeoutMs,providerFetch } from './provider-fetch';

// Re-export providers
export type { GcpTokenProvider } from './gcp';
export { GCP_LOCATIONS,GcpProvider } from './gcp';
export { DEFAULT_PLACEMENT_RETRY_DELAY_MS,HetznerProvider } from './hetzner';
export { SCALEWAY_LOCATIONS,ScalewayProvider } from './scaleway';

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
      );
    case 'scaleway':
      return new ScalewayProvider(
        config.secretKey,
        config.projectId,
        config.zone,
      );
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
      );
    default:
      throw new ProviderError(
        'factory',
        undefined,
        `Unsupported provider: ${(config as { provider: string }).provider}`,
      );
  }
}
