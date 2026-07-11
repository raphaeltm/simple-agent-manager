import * as cloudflare from '@pulumi/cloudflare';
import { accountId, prefix, r2Location, sessionSnapshotTtlDays, stack } from './config';

export const SESSION_SNAPSHOT_LIFECYCLE_RULE_ID = 'expire-session-snapshots';
export const SESSION_SNAPSHOT_R2_PREFIX = 'session-snapshots/';
const SECONDS_PER_DAY = 24 * 60 * 60;

export const r2Bucket = new cloudflare.R2Bucket(`${prefix}-r2`, {
  accountId,
  name: `${prefix}-${stack}-assets`,
  location: r2Location,
});

export const r2BucketLifecycle = new cloudflare.R2BucketLifecycle(
  `${prefix}-r2-lifecycle`,
  {
    accountId,
    bucketName: r2Bucket.name,
    rules: [
      {
        id: SESSION_SNAPSHOT_LIFECYCLE_RULE_ID,
        conditions: { prefix: SESSION_SNAPSHOT_R2_PREFIX },
        enabled: true,
        deleteObjectsTransition: {
          condition: {
            maxAge: sessionSnapshotTtlDays * SECONDS_PER_DAY,
            type: 'Age',
          },
        },
      },
    ],
  },
  { dependsOn: r2Bucket }
);

export const r2BucketName = r2Bucket.name;
