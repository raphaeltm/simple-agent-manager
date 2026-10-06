import { describe, expect, it } from 'vitest';

import {
  buildProviderConfig,
  serializeCredentialToken,
} from '../../../src/services/provider-credentials';
describe('UpCloud provider credentials', () => {
  it('serializes username/password as structured JSON without losing delimiters', () => {
    const value = serializeCredentialToken('upcloud', { username: 'api:user', password: 'p:a:ss' });
    expect(JSON.parse(value)).toEqual({ username: 'api:user', password: 'p:a:ss' });
  });
  it('builds provider config and threads runtime overrides', () => {
    const value = serializeCredentialToken('upcloud', { username: 'user', password: 'secret' });
    expect(
      buildProviderConfig('upcloud', value, {
        UPCLOUD_API_URL: 'https://upcloud.test/1.3',
        UPCLOUD_ZONE: 'fi-hel1',
        UPCLOUD_IMAGE_TITLE: 'Ubuntu 24.04',
        UPCLOUD_API_TIMEOUT_MS: '1234',
        UPCLOUD_IP_POLL_TIMEOUT_MS: '2345',
        UPCLOUD_IP_POLL_INTERVAL_MS: '25',
        UPCLOUD_STOP_TIMEOUT_SECONDS: '90',
      })
    ).toEqual({
      provider: 'upcloud',
      username: 'user',
      password: 'secret',
      apiUrl: 'https://upcloud.test/1.3',
      zone: 'fi-hel1',
      imageTitle: 'Ubuntu 24.04',
      requestTimeoutMs: 1234,
      ipPollTimeoutMs: 2345,
      ipPollIntervalMs: 25,
      stopTimeoutSeconds: 90,
    });
  });
  it('fails closed on malformed or incomplete stored data', () => {
    expect(() => buildProviderConfig('upcloud', 'not-json')).toThrow('malformed');
    expect(() => buildProviderConfig('upcloud', JSON.stringify({ username: 'u' }))).toThrow(
      'missing username or password'
    );
  });
});
