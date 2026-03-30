/**
 * Configure R2 bucket CORS rules for direct browser uploads via presigned URLs.
 *
 * Uses the AWS S3-compatible API (PutBucketCors) to set CORS rules on the R2 bucket.
 * This allows the browser to PUT files directly to R2 using presigned URLs.
 *
 * Required env vars:
 *   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID, R2_BUCKET_NAME, BASE_DOMAIN
 */
import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3';

const {
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  CF_ACCOUNT_ID,
  R2_BUCKET_NAME,
  BASE_DOMAIN,
} = process.env;

if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !CF_ACCOUNT_ID || !R2_BUCKET_NAME || !BASE_DOMAIN) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const appOrigin = `https://app.${BASE_DOMAIN}`;

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const command = new PutBucketCorsCommand({
  Bucket: R2_BUCKET_NAME,
  CORSConfiguration: {
    CORSRules: [
      {
        AllowedOrigins: [appOrigin],
        AllowedMethods: ['PUT'],
        AllowedHeaders: ['Content-Type', 'Content-Length'],
        MaxAgeSeconds: 3600,
      },
    ],
  },
});

try {
  await client.send(command);
  console.log(`  Bucket: ${R2_BUCKET_NAME}`);
  console.log(`  Allowed Origin: ${appOrigin}`);
  console.log(`  Allowed Methods: PUT`);
  console.log(`  Allowed Headers: Content-Type, Content-Length`);
} catch (err) {
  console.error('Failed to configure R2 CORS:', err instanceof Error ? err.message : err);
  process.exit(1);
}
