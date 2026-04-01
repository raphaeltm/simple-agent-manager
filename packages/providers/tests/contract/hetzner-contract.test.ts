import { afterEach,beforeEach } from 'vitest';

import { HetznerProvider } from '../../src/hetzner';
import { createHetznerFetchMock } from '../fixtures/hetzner-mocks';
import { runProviderContractTests } from './provider-contract.test';

/**
 * Run the reusable contract test suite against HetznerProvider
 * with all API calls mocked.
 */

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = createHetznerFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

runProviderContractTests(
  () => new HetznerProvider('contract-test-token'),
  { name: 'HetznerProvider Contract' },
);
