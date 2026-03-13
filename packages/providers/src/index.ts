import type { Provider, ProviderConfig } from './types';
import { ProviderError } from './types';
import { HetznerProvider } from './hetzner';

// Re-export types
export type {
  Provider,
  ProviderConfig,
  HetznerProviderConfig,
  UpCloudProviderConfig,
  ScalewayProviderConfig,
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
      throw new ProviderError(
        'scaleway',
        undefined,
        'Scaleway provider is not yet implemented. See tasks/backlog/2026-02-16-provider-scaleway.md',
      );
    default:
      throw new ProviderError(
        'factory',
        undefined,
        `Unsupported provider: ${(config as { provider: string }).provider}`,
      );
  }
}
