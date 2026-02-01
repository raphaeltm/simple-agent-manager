import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

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
export const appDnsRecord = new cloudflare.Record(`${prefix}-dns-app`, {
  zoneId: zoneId,
  name: `app`,
  type: "CNAME",
  content: `${prefix}-web-${stack}.pages.dev`,
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

export const dnsRecordIds = {
  api: apiDnsRecord.id,
  app: appDnsRecord.id,
  wildcard: wildcardDnsRecord.id,
};

export const dnsHostnames = {
  api: pulumi.interpolate`api.${baseDomain}`,
  app: pulumi.interpolate`app.${baseDomain}`,
};
