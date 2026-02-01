import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("cloudflareAccountId");
const prefix = config.get("resourcePrefix") || "sam";
const stack = pulumi.getStack();

export const kvNamespace = new cloudflare.WorkersKvNamespace(`${prefix}-kv`, {
  accountId: accountId,
  title: `${prefix}-${stack}-sessions`,
});

export const kvNamespaceId = kvNamespace.id;
export const kvNamespaceName = kvNamespace.title;
