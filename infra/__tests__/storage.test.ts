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

  it('provisions all independent prefix-scoped retention rules', async () => {
    const lifecycle = findRegisteredResource(
      `${configModule.prefix}-r2-lifecycle`,
      'cloudflare:index/r2BucketLifecycle:R2BucketLifecycle'
    );

    expect(await getOutputValue(lifecycle.inputs.bucketName as never)).toBe(
      configModule.prefix + '-' + configModule.stack + '-assets'
    );
    expect(lifecycle.inputs).toMatchObject({
      accountId: 'test-account-id-00000000000000000000',
      rules: [
        {
          id: storageModule.DIAGNOSTIC_INCIDENT_LIFECYCLE_RULE_ID,
          conditions: { prefix: storageModule.DIAGNOSTIC_INCIDENT_R2_PREFIX },
          enabled: true,
          deleteObjectsTransition: {
            condition: {
              maxAge: configModule.DEFAULT_DIAGNOSTIC_INCIDENT_TTL_DAYS * 24 * 60 * 60,
              type: 'Age',
            },
          },
        },
        {
          id: storageModule.TEMP_UPLOAD_LIFECYCLE_RULE_ID,
          conditions: { prefix: storageModule.TEMP_UPLOAD_R2_PREFIX },
          enabled: true,
          deleteObjectsTransition: {
            condition: {
              maxAge: configModule.DEFAULT_TEMP_UPLOAD_TTL_DAYS * 24 * 60 * 60,
              type: 'Age',
            },
          },
        },
        {
          id: storageModule.TTS_LIFECYCLE_RULE_ID,
          conditions: { prefix: storageModule.TTS_R2_PREFIX },
          enabled: true,
          deleteObjectsTransition: {
            condition: {
              maxAge: configModule.DEFAULT_TTS_TTL_DAYS * 24 * 60 * 60,
              type: 'Age',
            },
          },
        },
      ],
    });
  });

  it('does not apply age-based expiry to durable or session-state artifacts', () => {
    const lifecycle = findRegisteredResource(
      `${configModule.prefix}-r2-lifecycle`,
      'cloudflare:index/r2BucketLifecycle:R2BucketLifecycle'
    );
    const prefixes = (lifecycle.inputs.rules as Array<{ conditions: { prefix: string } }>).map(
      (rule) => rule.conditions.prefix
    );

    expect(prefixes).not.toContain('library/');
    expect(prefixes).not.toContain('compose-image-artifacts/');
    expect(prefixes).not.toContain('session-snapshots/');
  });
});
