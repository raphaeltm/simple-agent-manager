import { GcpProvider } from '../../src/gcp';
import { runProviderCancellationContractTests } from './provider-contract.test';

runProviderCancellationContractTests(
  () => new GcpProvider('contract-project', async () => 'contract-access-token'),
  { name: 'GcpProvider Contract' }
);
