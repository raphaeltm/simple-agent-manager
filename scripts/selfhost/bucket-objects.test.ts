import { describe, expect, it, vi } from 'vitest';

import { type BoxContext, parseBucketUrl } from './backup-lib';
import { listObjects } from './bucket-objects';

function context(bucket: string, stdout: string): BoxContext {
  return {
    box: {
      CELLD_BUCKET: bucket,
      S3_ENDPOINT: 'http://store.example',
      AWS_ACCESS_KEY_ID: 'fixture',
      AWS_SECRET_ACCESS_KEY: 'fixture',
    },
    envFile: '/unused',
    stateDir: '/unused',
    composeFiles: [],
    now: Date.now,
    log: vi.fn(),
    run: vi.fn(() => ({ status: 0, stdout, stderr: '' })),
  };
}

describe('fleet object listings', () => {
  it('parses GCS listing records and ignores totals, unrelated roots and malformed records', () => {
    const ctx = context(
      'gs://fleet/celld',
      ' 12 2026-11-19T00:00:00Z gs://fleet/celld/deploy/file.json\nTOTAL: 1 objects\n5 now gs://other/file\n5 now gs://fleet/celld/x extra\n'
    );
    expect(listObjects(ctx, 'deploy/')).toEqual([
      { key: 'deploy/file.json', size: 12, lastModified: '2026-11-19T00:00:00Z' },
    ]);
    expect(ctx.run).toHaveBeenCalledWith('gcloud', [
      'storage',
      'ls',
      '--long',
      'gs://fleet/celld/deploy/**',
    ]);
  });
  it('preserves S3 string timestamps and missing timestamps without object stringification', () => {
    const ctx = context(
      's3://fleet/celld',
      [
        JSON.stringify({
          type: 'file',
          key: 'a.json',
          size: 7,
          lastModified: '2026-11-19T00:00:00Z',
        }),
        JSON.stringify({ type: 'file', key: 'b.json', size: 2 }),
        JSON.stringify({ type: 'folder', key: 'ignored' }),
      ].join('\n')
    );
    expect(listObjects(ctx, 'deploy/')).toEqual([
      { key: 'deploy/a.json', size: 7, lastModified: '2026-11-19T00:00:00Z' },
      { key: 'deploy/b.json', size: 2, lastModified: '' },
    ]);
  });
  it.each([{}, [], 1, true])('refuses a non-string S3 timestamp %j', (lastModified) => {
    const ctx = context(
      's3://fleet/celld',
      JSON.stringify({ type: 'file', key: 'a', lastModified })
    );
    expect(() => listObjects(ctx, '')).toThrow('Invalid object timestamp from store');
  });
  it('sanitizes malformed object listing errors', () => {
    const ctx = context('s3://fleet/celld', '{"fixture-sensitive-fragment');
    expect(() => listObjects(ctx, '')).toThrow('Invalid object listing from store');
  });
});

describe('bucket URL parsing', () => {
  it('parses optional prefixes and strips a long run of trailing slashes with bounded scanning', () => {
    expect(parseBucketUrl(' gs://fleet ')).toEqual({ scheme: 'gs', bucket: 'fleet', prefix: '' });
    expect(parseBucketUrl('s3://fleet/a/b' + '/'.repeat(100_000))).toEqual({
      scheme: 's3',
      bucket: 'fleet',
      prefix: 'a/b',
    });
  });
  it.each(['gs:///prefix', 'https://fleet', 's3://', 'gs://fleet/path\nextra'])(
    'refuses invalid bucket URL %j',
    (value) => {
      expect(() => parseBucketUrl(value)).toThrow('CELLD_BUCKET must be');
    }
  );
});
