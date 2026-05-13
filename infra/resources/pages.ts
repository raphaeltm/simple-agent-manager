import * as cloudflare from "@pulumi/cloudflare";
import { accountId, baseDomain, prefix, stack } from "./config";

export const pagesProject = new cloudflare.PagesProject(
  `${prefix}-pages-project`,
  {
    accountId: accountId,
    name: `${prefix}-web-${stack}`,
    productionBranch: "main",
  }
);

// Custom domain for Pages — takes precedence over Worker wildcard routes
// Without this, the Worker route *.{domain}/* would catch app.{domain} requests
export const pagesCustomDomain = new cloudflare.PagesDomain(
  `${prefix}-pages-domain`,
  {
    accountId: accountId,
    projectName: pagesProject.name,
    domain: `app.${baseDomain}`,
  }
);

export const pagesProjectName = pagesProject.name;
