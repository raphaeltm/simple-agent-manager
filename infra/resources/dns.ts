import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
import { pagesProject } from './pages';
import { deploymentHostnames, zoneId, prefix, stack } from './config';

const apiWorkerHostname = `${prefix}-api-${stack}.${prefix}.workers.dev`;

// API subdomain (api.example.com -> Worker)
export const apiDnsRecord = new cloudflare.Record(`${prefix}-dns-api`, {
  zoneId: zoneId,
  name: deploymentHostnames.api,
  type: 'CNAME',
  content: apiWorkerHostname,
  proxied: true,
  ttl: 1,
  comment: `${prefix.toUpperCase()} API - managed by Pulumi`,
});

// App subdomain (app.example.com -> Pages)
// IMPORTANT: Use the actual subdomain from the Pages project, not the computed name.
// Cloudflare Pages subdomains are globally unique — if "sa379a6-web-prod" is taken by another
// account, CF assigns a suffix (e.g., "sa379a6-web-prod-eui"). Using the computed name would
// CNAME to someone else's Pages project.
export const appDnsRecord = new cloudflare.Record(`${prefix}-dns-app`, {
  zoneId: zoneId,
  name: deploymentHostnames.app,
  type: 'CNAME',
  content: pagesProject.subdomain,
  proxied: true,
  ttl: 1,
  comment: `${prefix.toUpperCase()} Web UI - managed by Pulumi`,
});

// Wildcard subdomain (*.example.com -> Worker for workspace routing)
export const wildcardDnsRecord = new cloudflare.Record(`${prefix}-dns-wildcard`, {
  zoneId: zoneId,
  name: deploymentHostnames.wildcard,
  type: 'CNAME',
  content: apiWorkerHostname,
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
export const vmRouteExclusion = new cloudflare.WorkersRoute(`${prefix}-route-vm-exclusion`, {
  zoneId: zoneId,
  pattern: `${deploymentHostnames.vmWildcard}/*`,
  // No scriptName → route exclusion (requests bypass Worker, go to origin)
});

export const dnsRecordIds = {
  api: apiDnsRecord.id,
  app: appDnsRecord.id,
  wildcard: wildcardDnsRecord.id,
};

export const dnsHostnames = {
  api: pulumi.output(deploymentHostnames.api),
  app: pulumi.output(deploymentHostnames.app),
  vmBackend: pulumi.output(deploymentHostnames.vmWildcard),
};
