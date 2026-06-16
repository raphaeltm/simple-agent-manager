import * as cloudflare from '@pulumi/cloudflare';
import { accountId, prefix, r2Location, stack } from './config';

export const r2Bucket = new cloudflare.R2Bucket(`${prefix}-r2`, {
  accountId: accountId,
  name: `${prefix}-${stack}-assets`,
  location: r2Location,
});

export const r2BucketName = r2Bucket.name;
