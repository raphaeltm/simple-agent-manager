// Import types and providers
import type { Provider } from './types';
import { HetznerProvider } from './hetzner';
import { DevcontainerProvider } from './devcontainer';

// Re-export types
export type { Provider, ProviderConfig, SizeConfig, VMConfig, VMInstance, ExecResult } from './types';

// Re-export providers
export { HetznerProvider } from './hetzner';
export { DevcontainerProvider } from './devcontainer';

// Provider factory
export function createProvider(type?: 'hetzner' | 'devcontainer'): Provider {
  // Use environment variable if type not specified
  const providerType = type || process.env.PROVIDER_TYPE || 'hetzner';

  switch (providerType) {
    case 'devcontainer':
      return new DevcontainerProvider();
    case 'hetzner':
    default:
      return new HetznerProvider({
        apiToken: process.env.HETZNER_TOKEN || '',
      });
  }
}
