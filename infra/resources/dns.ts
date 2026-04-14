import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import { pagesProject } from "./pages";

const config = new pulumi.Config();
const zoneId = config.require("cloudflareZoneId");
const baseDomain = config.require("baseDomain");
const prefix = config.get("resourcePrefix") || "sam";
const stack = pulumi.getStack();

// API subdomain (api.example.com -> Worker)
export const apiDnsRecord = new cloudflare.Record(`${prefix}-dns-api`, {
  zoneId: zoneId,
  name: `api`,
  type: "CNAME",
  content: `${prefix}-api-${stack}.workers.dev`,
  proxied: true,
  ttl: 1,
  comment: `${prefix.toUpperCase()} API - managed by Pulumi`,
});

// App subdomain (app.example.com -> Pages)
// IMPORTANT: Use the actual subdomain from the Pages project, not the computed name.
// Cloudflare Pages subdomains are globally unique — if "sam-web-prod" is taken by another
// account, CF assigns a suffix (e.g., "sam-web-prod-eui"). Using the computed name would
// CNAME to someone else's Pages project.
export const appDnsRecord = new cloudflare.Record(`${prefix}-dns-app`, {
  zoneId: zoneId,
  name: `app`,
  type: "CNAME",
  content: pagesProject.subdomain,
  proxied: true,
  ttl: 1,
  comment: `${prefix.toUpperCase()} Web UI - managed by Pulumi`,
});

// Wildcard subdomain (*.example.com -> Worker for workspace routing)
export const wildcardDnsRecord = new cloudflare.Record(`${prefix}-dns-wildcard`, {
  zoneId: zoneId,
  name: `*`,
  type: "CNAME",
  content: `${prefix}-api-${stack}.workers.dev`,
  proxied: true,
  ttl: 1,
  comment: `${prefix.toUpperCase()} Workspaces - managed by Pulumi`,
});

/**
 * Worker route exclusion for *.vm.{domain}.
 *
 * The wildcard Worker route *.{domain}/* uses a GREEDY wildcard that matches
 * any number of subdomain levels (including a.b.domain). This means
 * {nodeId}.vm.{domain} requests are intercepted by the Worker, causing
 * same-zone routing loops for DO alarm subrequests to VM agents.
 *
 * This exclusion route *.vm.{domain}/* is MORE SPECIFIC than *.{domain}/*,
 * so it takes precedence. With no scriptName, requests pass straight to
 * origin (the VM, via proxied DNS) — including Worker subrequests.
 *
 * See docs/notes/2026-03-12-same-zone-routing-postmortem.md.
 */
export const vmRouteExclusion = new cloudflare.WorkerRoute(`${prefix}-route-vm-exclusion`, {
  zoneId: zoneId,
  pattern: `*.vm.${baseDomain}/*`,
  // No scriptName → route exclusion (requests bypass Worker, go to origin)
});

export const dnsRecordIds = {
  api: apiDnsRecord.id,
  app: appDnsRecord.id,
  wildcard: wildcardDnsRecord.id,
};

export const dnsHostnames = {
  api: pulumi.interpolate`api.${baseDomain}`,
  app: pulumi.interpolate`app.${baseDomain}`,
  vmBackend: pulumi.interpolate`*.vm.${baseDomain}`,
};
