# Quickstart: Provider Interface Modernization

## For Implementors: Adding a New Provider

### 1. Create the Provider Class

```typescript
// packages/providers/src/my-provider.ts
import { Provider, VMConfig, VMInstance, SizeConfig, ProviderError } from './types';
import { providerFetch } from './provider-fetch';
import type { VMSize } from '@simple-agent-manager/shared';

const SIZES: Record<VMSize, SizeConfig> = {
  small:  { type: 'DEV-1', price: '$5/mo',  vcpu: 1, ramGb: 2,  storageGb: 25 },
  medium: { type: 'DEV-2', price: '$10/mo', vcpu: 2, ramGb: 4,  storageGb: 50 },
  large:  { type: 'DEV-4', price: '$20/mo', vcpu: 4, ramGb: 8,  storageGb: 100 },
};

export class MyProvider implements Provider {
  readonly name = 'my-provider';
  readonly locations = ['us-east', 'eu-west'] as const;
  readonly sizes = SIZES;

  constructor(private readonly apiToken: string) {}

  async createVM(config: VMConfig): Promise<VMInstance> {
    const sizeConfig = this.sizes[config.size];
    const response = await providerFetch(this.name, 'https://api.my-provider.com/servers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: JSON.stringify({
        name: config.name,
        plan: sizeConfig.type,
        region: config.location,
        user_data: config.userData,
      }),
    });
    const data = await response.json();
    return this.mapToVMInstance(data.server);
  }

  async deleteVM(id: string): Promise<void> { /* 404 = no-op */ }
  async getVM(id: string): Promise<VMInstance | null> { /* 404 = null */ }
  async listVMs(labels?: Record<string, string>): Promise<VMInstance[]> { /* ... */ }
  async powerOff(id: string): Promise<void> { /* ... */ }
  async powerOn(id: string): Promise<void> { /* ... */ }
  async validateToken(): Promise<boolean> { /* test API call */ }
}
```

### 2. Register in the Factory

```typescript
// packages/providers/src/index.ts
import { MyProvider } from './my-provider';

export function createProvider(config: ProviderConfig): Provider {
  switch (config.provider) {
    case 'hetzner':
      return new HetznerProvider(config.apiToken, config.datacenter);
    case 'my-provider':
      return new MyProvider(config.apiToken);
    default:
      throw new ProviderError('factory', undefined, `Unsupported provider: ${(config as any).provider}`);
  }
}
```

### 3. Run the Contract Tests

```typescript
// packages/providers/tests/contract/my-provider-contract.test.ts
import { runProviderContractTests } from './provider-contract.test';
import { MyProvider } from '../../src/my-provider';

runProviderContractTests(() => new MyProvider('test-token'));
```

### 4. No Other Changes Needed

The API layer uses the provider polymorphically. No changes needed to:
- `apps/api/src/routes/` (routes)
- `apps/api/src/services/nodes.ts` (orchestration)
- `apps/web/` (UI)

## For API Consumers: Using the Provider

```typescript
// In API route/service code
import { createProvider } from '@simple-agent-manager/providers';
import { generateCloudInit } from '@simple-agent-manager/cloud-init';

// 1. Get user's credentials from DB and decrypt
const credential = await getDecryptedCredential(userId, env);

// 2. Create provider instance
const provider = createProvider({
  provider: credential.provider,  // 'hetzner'
  apiToken: credential.token,
});

// 3. Generate cloud-init (secrets handled here, NOT in provider)
const userData = generateCloudInit({ nodeId, hostname, controlPlaneUrl, ... });

// 4. Create VM via provider interface
const vm = await provider.createVM({
  name: `node-${nodeId}`,
  size: 'medium',
  location: 'fsn1',
  userData,
  labels: { node: nodeId, managed: 'simple-agent-manager' },
});
```

## Key Design Decisions

1. **VMConfig has no secrets** — cloud-init handles secret injection
2. **Provider owns no cloud-init logic** — `@simple-agent-manager/cloud-init` generates it
3. **Factory takes explicit config** — no `process.env` access (Workers-compatible)
4. **providerFetch wraps all HTTP** — automatic timeout + ProviderError normalization
5. **deleteVM is idempotent** — 404 from provider API is silently ignored
6. **getVM returns null** — not-found is not an error
