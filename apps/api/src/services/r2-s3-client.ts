import { S3Client } from '@aws-sdk/client-s3';

import type { Env } from '../env';
import {
  type R2PresignConfig,
  r2PresignObjectKey,
  resolveR2PresignConfig,
} from './r2-presign-config';

/**
 * How the SDK adds flexible checksums to requests. Attachments and snapshots presign with
 * `WHEN_REQUIRED` so the browser or VM need not send a CRC header; compose image artifacts
 * keep the SDK default they have always been signed with.
 */
export type R2ChecksumMode = 'WHEN_REQUIRED' | 'SDK_DEFAULT';

export interface R2PresignTarget {
  client: S3Client;
  /** S3 bucket the URL addresses. */
  bucket: string;
  /** S3 object key for an R2 key (prefix applied for operator stores). */
  objectKey(r2Key: string): string;
}

/** One client per configuration and checksum mode; a rotation adds at most a few entries. */
const MAX_CACHED_CLIENTS = 4;
const clients = new Map<string, S3Client>();

export function hasR2S3Credentials(env: Env): boolean {
  return resolveR2PresignConfig(env) !== null;
}

function clientFor(config: R2PresignConfig, checksum: R2ChecksumMode): S3Client {
  const cacheKey = JSON.stringify([
    config.endpoint,
    config.region,
    config.forcePathStyle ?? null,
    config.accessKeyId,
    checksum,
  ]);
  let client = clients.get(cacheKey);
  if (!client) {
    client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(checksum === 'WHEN_REQUIRED' ? { requestChecksumCalculation: 'WHEN_REQUIRED' } : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    // Rotated credentials must not accumulate clients for the life of the isolate.
    if (clients.size >= MAX_CACHED_CLIENTS) clients.clear();
    clients.set(cacheKey, client);
  }
  return client;
}

/** The one place presigned R2 URLs get their client, bucket and object key (rule 24). */
export function getR2PresignTarget(
  env: Env,
  checksum: R2ChecksumMode = 'WHEN_REQUIRED'
): R2PresignTarget {
  const config = resolveR2PresignConfig(env);
  if (!config) {
    throw new Error(
      'R2 S3 credentials not configured (R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, plus CF_ACCOUNT_ID and R2_BUCKET_NAME on Cloudflare, or R2_S3_ENDPOINT, R2_S3_BUCKET and R2_S3_KEY_PREFIX for an operator store)'
    );
  }
  return {
    client: clientFor(config, checksum),
    bucket: config.bucket,
    objectKey: (r2Key) => r2PresignObjectKey(config, r2Key),
  };
}

/** Test seam: forget cached clients. */
export function resetR2S3ClientsForTests(): void {
  clients.clear();
}
