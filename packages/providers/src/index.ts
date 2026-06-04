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
} from './types';
export { ProviderError } from './types';

// Re-export utilities
export { getTimeoutMs,providerFetch } from './provider-fetch';

// Re-export providers and classification functions
export type { GcpTokenProvider } from './gcp';
export { classifyGcpError, DEFAULT_GCP_AGENT_PORTS, DEFAULT_GCP_FIREWALL_SOURCE_RANGES, GCP_LOCATIONS,GcpProvider } from './gcp';
export type { HetznerProviderRuntimeOptions } from './hetzner';
export {
  classifyHetznerError,
  DEFAULT_CAPACITY_RETRY_BUDGET_MS,
  DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS,
  DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS,
  DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS,
  DEFAULT_PLACEMENT_RETRY_DELAY_MS,
  HetznerProvider,
  isTransientCapacityError,
} from './hetzner';
export { classifyScalewayError, SCALEWAY_LOCATIONS,ScalewayProvider } from './scaleway';

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
        },
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
        config.firewallSourceRanges,
        config.agentPorts,
      );
    default: {
      const _exhaustive: never = config;
      throw new ProviderError(
        'factory',
        undefined,
        `Unsupported provider: ${(_exhaustive as { provider: string }).provider}`,
      );
    }
  }
}
