import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("cloudflareAccountId");
const prefix = config.get("resourcePrefix") || "sam";
const stack = pulumi.getStack();

export const database = new cloudflare.D1Database(`${prefix}-database`, {
  accountId: accountId,
  name: `${prefix}-${stack}`,
});

export const databaseId = database.id;
export const databaseName = database.name;
