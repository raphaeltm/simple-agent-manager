// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type { ResolvedHostnameTarget } from '@simple-agent-manager/app-deployment';
export {
  matchesCustomDomainTarget,
  resolveHostnameTarget,
  verifyCustomDomainTarget,
} from '@simple-agent-manager/app-deployment';
