import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("cloudflareAccountId");
const prefix = config.get("resourcePrefix") || "sam";
const stack = pulumi.getStack();

export const pagesProject = new cloudflare.PagesProject(
  `${prefix}-pages-project`,
  {
    accountId: accountId,
    name: `${prefix}-web-${stack}`,
    productionBranch: "main",
  }
);

export const pagesProjectName = pagesProject.name;
