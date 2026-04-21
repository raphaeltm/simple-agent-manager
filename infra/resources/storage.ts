import * as cloudflare from "@pulumi/cloudflare";
import { accountId, prefix, stack } from "./config";

export const r2Bucket = new cloudflare.R2Bucket(`${prefix}-r2`, {
  accountId: accountId,
  name: `${prefix}-${stack}-assets`,
  // R2 locations: WNAM (Western North America), ENAM (Eastern North America),
  // WEUR (Western Europe), EEUR (Eastern Europe), APAC (Asia-Pacific), OC (Oceania)
  // Using WNAM as default for lowest latency from US
  location: "WNAM",
});

export const r2BucketName = r2Bucket.name;
