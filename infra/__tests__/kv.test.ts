import { describe, it, expect, beforeAll } from 'vitest';
import { findRegisteredResource, getOutputValue } from './setup';

describe('KV Namespace Resource', () => {
  let kvModule: typeof import('../resources/kv');
  let configModule: typeof import('../resources/config');

  beforeAll(async () => {
    kvModule = await import('../resources/kv');
    configModule = await import('../resources/config');
  });

  it('exports namespace outputs consumed by deployment scripts', async () => {
    const id = await getOutputValue(kvModule.kvNamespaceId);
    const name = await getOutputValue(kvModule.kvNamespaceName);

    expect(id).toBe(`${configModule.prefix}-kv-test-id`);
    expect(name).toBe(`${configModule.prefix}-${configModule.stack}-sessions`);
  });

  it('registers the sessions namespace with account wiring', () => {
    const namespace = findRegisteredResource(
      `${configModule.prefix}-kv`,
      'cloudflare:index/workersKvNamespace:WorkersKvNamespace'
    );

    expect(namespace.inputs).toMatchObject({
      accountId: 'test-account-id-00000000000000000000',
      title: `${configModule.prefix}-${configModule.stack}-sessions`,
    });
  });
});
