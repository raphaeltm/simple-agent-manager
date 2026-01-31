import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("cloudflareAccountId");
const prefix = config.get("resourcePrefix") || "sam";
const stack = pulumi.getStack();

export const r2Bucket = new cloudflare.R2Bucket(`${prefix}-r2`, {
  accountId: accountId,
  name: `${prefix}-${stack}-assets`,
  location: "auto",
});

export const r2BucketName = r2Bucket.name;
