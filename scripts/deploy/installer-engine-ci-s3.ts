/** Explicit S3 preflight: REST bucket permission alone does not prove Pulumi can read state. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export async function verifyCiStateAccess(environment: NodeJS.ProcessEnv): Promise<void> {
  const {
    PULUMI_STATE_BUCKET: bucket,
    CF_ACCOUNT_ID: accountId,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  } = environment;
  if (!bucket || !accountId || !accessKeyId || !secretAccessKey)
    throw new Error('Missing private S3 preflight settings');
  // This SDK belongs to apps/api; resolve the declared dependency from that package.
  const require = createRequire(resolve('apps/api/package.json'));
  const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3') as {
    S3Client: new (options: Record<string, unknown>) => {
      send(command: unknown): Promise<unknown>;
      destroy(): void;
    };
    HeadObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  };
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: '.pulumi/meta.yaml' }));
  } catch (error) {
    const failure = error as { $metadata?: { httpStatusCode?: number }; name?: string };
    if (
      failure.$metadata?.httpStatusCode === 404 ||
      failure.name === 'NotFound' ||
      failure.name === 'NoSuchKey'
    )
      return;
    throw new Error('Pulumi R2 S3 state access failed; repair the installation state credentials');
  } finally {
    client.destroy();
  }
}
if (process.argv[1]?.endsWith('installer-engine-ci-s3.ts'))
  verifyCiStateAccess(process.env).catch(() => {
    process.stderr.write(
      'Pulumi R2 S3 state access failed; no private upstream response was printed.\n'
    );
    process.exitCode = 1;
  });
