import { S3Client } from '@aws-sdk/client-s3';

import type { Env } from '../env';

let client: S3Client | null = null;
let clientKey = '';

export function hasR2S3Credentials(env: Env): boolean {
  return Boolean(
    env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CF_ACCOUNT_ID && env.R2_BUCKET_NAME
  );
}

export function getR2S3Client(env: Env): S3Client {
  const { CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_BUCKET_NAME, R2_SECRET_ACCESS_KEY } = env;
  if (!CF_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_BUCKET_NAME || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      'R2 S3 credentials not configured (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID, and R2_BUCKET_NAME required)'
    );
  }
  const key = `${CF_ACCOUNT_ID}:${R2_ACCESS_KEY_ID}`;
  if (!client || clientKey !== key) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
    clientKey = key;
  }
  return client;
}
