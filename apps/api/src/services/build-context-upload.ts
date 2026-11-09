import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Env } from '../env';
import type { BuildContextDescriptor, BuildContextOwner } from './build-context-state';
import { buildContextKey } from './build-context-state';
import { getS3Client } from './compose-image-artifacts';

/** Only job-derived keys are signed. Metadata binds the uploaded object to the
 * digest declared before upload; builders must still hash bytes after download. */
export async function createBuildContextUpload(
  env: Env,
  owner: BuildContextOwner,
  descriptor: BuildContextDescriptor,
  expiresIn: number
) {
  const r2Key = buildContextKey(owner);
  const uploadUrl = await getSignedUrl(
    getS3Client(env, 'WHEN_REQUIRED'),
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: r2Key,
      ContentLength: descriptor.sizeBytes,
      ContentType: 'application/zstd',
      Metadata: { sha256: descriptor.sha256 },
    }),
    { expiresIn }
  );
  return { r2Key, uploadUrl, expiresIn };
}
export async function verifyBuildContextObject(
  env: Env,
  owner: BuildContextOwner,
  descriptor: BuildContextDescriptor
) {
  const head = await env.R2.head(buildContextKey(owner));
  return (
    head !== null &&
    head.size === descriptor.sizeBytes &&
    head.customMetadata?.sha256 === descriptor.sha256
  );
}
