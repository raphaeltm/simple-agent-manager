import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { getR2S3Client, hasR2S3Credentials } from './r2-s3-client';

export const DEFAULT_SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS = 15 * 60;

export function sessionSnapshotDirectUploadAvailable(env: Env): boolean {
  return hasR2S3Credentials(env);
}

function checksumBase64(checksumHex: string): string {
  const bytes = Uint8Array.from(checksumHex.match(/.{2}/g) ?? [], (value) =>
    Number.parseInt(value, 16)
  );
  return btoa(String.fromCharCode(...bytes));
}

export async function generateSessionSnapshotDirectUploadUrl(
  env: Env,
  input: {
    key: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
  }
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: input.key,
    ContentLength: input.sizeBytes,
    ContentType: input.contentType,
    ChecksumSHA256: checksumBase64(input.sha256),
  });
  return getSignedUrl(getR2S3Client(env), command, {
    expiresIn: parsePositiveInt(
      env.SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS,
      DEFAULT_SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS
    ),
  });
}
