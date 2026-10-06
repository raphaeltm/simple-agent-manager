/**
 * DNS service barrel.
 *
 * The implementation lives in `dns-core.ts` (shared Cloudflare primitives),
 * `dns-app-routes.ts`, `dns-workspace.ts` and `dns-node-backend.ts`. This file
 * re-exports the public surface so existing `services/dns` imports keep working.
 * See `.claude/rules/18-file-size-limits.md`.
 */

export {
  cleanupAppRouteDNSRecords,
  deleteAppRouteDNSRecord,
  upsertAppRouteDNSRecord,
} from './dns-app-routes';
export type { DNSRecord, DNSServiceInterface } from './dns-core';
export {
  createDNSRecord,
  deleteDNSRecord,
  DNSService,
  getBackendHostname,
  getDnsTTL,
  getNodeBackendHostname,
  getWorkspaceUrl,
  updateDNSRecord,
} from './dns-core';
export { createBackendDNSRecord, createNodeBackendDNSRecord } from './dns-node-backend';
export { cleanupWorkspaceDNSRecords } from './dns-workspace';
