import { afterEach, beforeEach } from 'vitest';

import { VultrProvider } from '../../src/vultr';
import { createVultrFetchMock } from '../fixtures/vultr-mocks';
import { runProviderContractTests } from './provider-contract.test';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = createVultrFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

runProviderContractTests(
  () =>
    new VultrProvider('contract-test-token', {
      // Fast, bounded IP poll so createVM resolves the ready instance's IP quickly.
      ipPollTimeoutMs: 200,
      ipPollIntervalMs: 5,
    }),
  { name: 'VultrProvider Contract', createReturnsIp: true },
);
