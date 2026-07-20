import { GCP_CREDENTIAL_VERSION } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  buildProviderConfig,
  serializeCredentialToken,
} from '../../../src/services/provider-credentials';

describe('GCP credential serialization', () => {
  const gcpFields = {
    gcpProjectId: 'my-project',
    gcpProjectNumber: '123456789',
    serviceAccountEmail: 'sam-vm-manager@my-project.iam.gserviceaccount.com',
    wifPoolId: 'sam-pool',
    wifProviderId: 'sam-oidc',
    defaultZone: 'us-central1-a',
  };

  it('should serialize a legacy WIF input as the versioned workload-identity shape', () => {
    const result = serializeCredentialToken('gcp', gcpFields);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      version: GCP_CREDENTIAL_VERSION,
      provider: 'gcp',
      authType: 'workload-identity',
      ...gcpFields,
    });
  });

  it('should round-trip serialize and parse back correctly', () => {
    const serialized = serializeCredentialToken('gcp', gcpFields);
    const parsed = JSON.parse(serialized);
    expect(parsed.gcpProjectId).toBe('my-project');
    expect(parsed.gcpProjectNumber).toBe('123456789');
    expect(parsed.serviceAccountEmail).toBe('sam-vm-manager@my-project.iam.gserviceaccount.com');
    expect(parsed.wifPoolId).toBe('sam-pool');
    expect(parsed.wifProviderId).toBe('sam-oidc');
    expect(parsed.defaultZone).toBe('us-central1-a');
  });

  it('should throw for buildProviderConfig with gcp (must use createProviderForUser)', () => {
    const serialized = serializeCredentialToken('gcp', gcpFields);
    expect(() => buildProviderConfig('gcp', serialized)).toThrow();
  });
});
