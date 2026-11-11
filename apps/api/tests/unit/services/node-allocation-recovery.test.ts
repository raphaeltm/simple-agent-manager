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

  it('drops the raw message of a generic error (may carry SQL/params/user text)', () => {
    const err = new Error('DB error near "SELECT secret FROM users WHERE token = abc123"');
    const described = describeProvisioningAttemptFailure(err) as { error: Record<string, unknown> };
    expect(described.error).toEqual({ name: 'Error', statusCode: undefined });
    expect(JSON.stringify(described)).not.toContain('SELECT secret');
  });

  it('keeps and length-caps our own authored NodeAllocationUncertainError message', () => {
    const err = new NodeAllocationUncertainError('y'.repeat(500));
    const described = describeProvisioningAttemptFailure(err) as { error: { message: string } };
    expect(described.error.message.length).toBe(200);
  });
});
