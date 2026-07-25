import { describe, expect, it } from 'vitest';
import { VALID_CLOUD_PROVIDERS, validateCloudInitVariables } from '../src/generate';
describe('UpCloud cloud-init provider validation', () => {
  it('accepts upcloud', () => {
    expect(VALID_CLOUD_PROVIDERS).toContain('upcloud');
    expect(() =>
      validateCloudInitVariables({
        nodeId: 'node-upcloud',
        hostname: 'sam-upcloud',
        controlPlaneUrl: 'https://api.example.com',
        jwksUrl: 'https://api.example.com/.well-known/jwks.json',
        callbackToken: 'token-123',
        provider: 'upcloud',
      })
    ).not.toThrow();
  });
});
