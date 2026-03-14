import type { Provider, ProviderConfig } from './types';
import { ProviderError } from './types';
import { HetznerProvider } from './hetzner';
import { ScalewayProvider } from './scaleway';

// Re-export types
export type {
  Provider,
  ProviderConfig,
  HetznerProviderConfig,
  UpCloudProviderConfig,
  ScalewayProviderConfig,
  LocationMeta,
  SizeConfig,
  VMConfig,
  VMInstance,
  VMStatus,
} from './types';
export { ProviderError } from './types';

// Re-export utilities
export { providerFetch, getTimeoutMs } from './provider-fetch';

// Re-export providers
export { HetznerProvider, DEFAULT_PLACEMENT_RETRY_DELAY_MS } from './hetzner';
export { ScalewayProvider, SCALEWAY_LOCATIONS } from './scaleway';

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
        undefined, // imageName — use default
        config.ipPollTimeoutMs,
        config.ipPollIntervalMs,
      );
    default:
      throw new ProviderError(
        'factory',
        undefined,
        `Unsupported provider: ${(config as { provider: string }).provider}`,
      );
  }
}
