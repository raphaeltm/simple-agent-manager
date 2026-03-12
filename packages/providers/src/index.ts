import type { Provider, ProviderConfig } from './types';
import { ProviderError } from './types';
import { HetznerProvider } from './hetzner';

// Re-export types
export type {
  Provider,
  ProviderConfig,
  HetznerProviderConfig,
  UpCloudProviderConfig,
  SizeConfig,
  VMConfig,
  VMInstance,
  VMStatus,
} from './types';
export { ProviderError } from './types';

// Re-export utilities
export { providerFetch, getTimeoutMs } from './provider-fetch';

// Re-export providers
export { HetznerProvider } from './hetzner';

/**
 * Create a provider instance from explicit configuration.
 * MUST NOT access process.env or any Node.js-only APIs.
 */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.provider) {
    case 'hetzner':
      return new HetznerProvider(config.apiToken, config.datacenter);
    default:
      throw new ProviderError(
        'factory',
        undefined,
        `Unsupported provider: ${(config as { provider: string }).provider}`,
      );
  }
}
