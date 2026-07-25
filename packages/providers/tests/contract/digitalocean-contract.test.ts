import { afterEach, beforeEach } from 'vitest';

import { DigitalOceanProvider } from '../../src/digitalocean';
import { createDigitalOceanFetchMock } from '../fixtures/digitalocean-mocks';
import { runProviderContractTests } from './provider-contract.test';
const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = createDigitalOceanFetchMock(); });
afterEach(() => { globalThis.fetch = originalFetch; });
runProviderContractTests(
  () => new DigitalOceanProvider('contract-token', { ipPollTimeoutMs: 100, ipPollIntervalMs: 1, actionPollTimeoutMs: 100 }),
  { name: 'DigitalOceanProvider Contract', createReturnsIp: true },
);
