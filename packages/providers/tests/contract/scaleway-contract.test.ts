import { afterEach,beforeEach } from 'vitest';

import { ScalewayProvider } from '../../src/scaleway';
import { createScalewayFetchMock } from '../fixtures/scaleway-mocks';
import { runProviderContractTests } from './provider-contract.test';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = createScalewayFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

runProviderContractTests(
  () => new ScalewayProvider('contract-test-token', 'contract-project-id'),
  { name: 'ScalewayProvider Contract', createReturnsIp: false },
);
