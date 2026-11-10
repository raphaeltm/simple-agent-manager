import { ProviderError } from '@simple-agent-manager/providers';
import { describe, expect, it } from 'vitest';

import {
  describeProvisioningAttemptFailure,
  NodeAllocationUncertainError,
} from '../../../src/services/node-allocation-recovery';

describe('describeProvisioningAttemptFailure', () => {
  it('reduces a ProviderError to safe structured fields and drops its raw message', () => {
    // A real GCP provider error message embeds the resource path and zone URL.
    const leaky =
      'gcp API error (412): error during placement for ' +
      'projects/sam-vm-control-plane-test/zones/europe-west1-b/instances/node-01abc ' +
      'sa sam-vmtest-nodes@sam-vm-control-plane-test.iam.gserviceaccount.com';
    const err = new NodeAllocationUncertainError(undefined, {
      cause: new ProviderError('gcp', 412, leaky, {
        providerCode: 'placement_error',
        category: 'capacity',
      }),
    });

    const described = describeProvisioningAttemptFailure(err);
    const serialized = JSON.stringify(described);

    // The wrapper's own message is safe and present.
    expect(described.error).toMatchObject({ name: 'NodeAllocationUncertainError' });
    // The ProviderError cause is reduced to safe fields.
    expect(described.cause).toEqual({
      name: 'ProviderError',
      providerName: 'gcp',
      statusCode: 412,
      providerCode: 'placement_error',
      category: 'capacity',
    });
    // None of the leaked resource identifiers reach the log payload.
    expect(serialized).not.toContain('europe-west1-b/instances');
    expect(serialized).not.toContain('iam.gserviceaccount.com');
    expect(serialized).not.toContain('error during placement');
  });

  it('length-caps a generic error message as a backstop', () => {
    const err = new Error('x'.repeat(500));
    const described = describeProvisioningAttemptFailure(err) as {
      error: { message: string };
    };
    expect(described.error.message.length).toBe(200);
  });
});
