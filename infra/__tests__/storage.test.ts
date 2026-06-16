import { describe, it, expect, beforeAll } from 'vitest';
import { findRegisteredResource, getOutputValue } from './setup';

describe('R2 Bucket Resource', () => {
  let storageModule: typeof import('../resources/storage');
  let configModule: typeof import('../resources/config');

  beforeAll(async () => {
    storageModule = await import('../resources/storage');
    configModule = await import('../resources/config');
  });

  it('exports the bucket name consumed by deployment scripts', async () => {
    const name = await getOutputValue(storageModule.r2BucketName);
    expect(name).toBe(`${configModule.prefix}-${configModule.stack}-assets`);
  });

  it('registers the assets bucket with account wiring and configured default location', () => {
    const bucket = findRegisteredResource(
      `${configModule.prefix}-r2`,
      'cloudflare:index/r2Bucket:R2Bucket'
    );

    expect(bucket.inputs).toMatchObject({
      accountId: 'test-account-id-00000000000000000000',
      name: `${configModule.prefix}-${configModule.stack}-assets`,
      location: configModule.DEFAULT_R2_LOCATION,
    });
  });
});
