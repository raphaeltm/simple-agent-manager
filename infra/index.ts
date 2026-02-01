import * as pulumi from "@pulumi/pulumi";

// Import all resource modules
import { database, databaseId, databaseName } from "./resources/database";
import { kvNamespace, kvNamespaceId, kvNamespaceName } from "./resources/kv";
import { r2Bucket, r2BucketName } from "./resources/storage";
import {
  apiDnsRecord,
  appDnsRecord,
  wildcardDnsRecord,
  dnsRecordIds,
  dnsHostnames,
} from "./resources/dns";

// Export resource references for internal use
export {
  database,
  kvNamespace,
  r2Bucket,
  apiDnsRecord,
  appDnsRecord,
  wildcardDnsRecord,
};

// Export outputs for use by deployment scripts (sync-wrangler-config.ts)
export const d1DatabaseId = databaseId;
export const d1DatabaseName = databaseName;
export const kvId = kvNamespaceId;
export const kvName = kvNamespaceName;
export const r2Name = r2BucketName;
export const dnsIds = dnsRecordIds;
export const hostnames = dnsHostnames;

// Stack summary output
const config = new pulumi.Config();
export const stackSummary = {
  stack: pulumi.getStack(),
  baseDomain: config.require("baseDomain"),
  resources: {
    d1: d1DatabaseName,
    kv: kvName,
    r2: r2Name,
  },
};
