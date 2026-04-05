import { isSidecarAlias } from '@simple-agent-manager/shared';
import type { SidecarAlias } from '@simple-agent-manager/shared';

/**
 * Parsed workspace subdomain result.
 * Pattern: ws-{id}.{domain}, ws-{id}--{port}.{domain}, or ws-{id}--{sidecar}.{domain}
 */
export interface WorkspaceSubdomain {
  workspaceId: string;
  targetPort: number | null;
  /** Named sidecar alias (e.g., 'browser') for routing to sidecar containers. */
  sidecar: SidecarAlias | null;
}

/**
 * Parse a workspace subdomain into workspace ID and optional port or sidecar alias.
 *
 * @param hostname - Full hostname (e.g., "ws-abc123--3000.example.com" or "ws-abc123--browser.example.com")
 * @param baseDomain - Base domain (e.g., "example.com")
 * @returns Parsed result, or null if the hostname is not a workspace subdomain
 */
export function parseWorkspaceSubdomain(
  hostname: string,
  baseDomain: string
): WorkspaceSubdomain | { error: string } | null {
  if (!baseDomain || !hostname.startsWith('ws-') || !hostname.endsWith(`.${baseDomain}`)) {
    return null;
  }

  const subdomain = hostname.replace(`.${baseDomain}`, '');
  let workspaceId: string;
  let targetPort: number | null = null;
  let sidecar: SidecarAlias | null = null;

  if (subdomain.includes('--')) {
    const parts = subdomain.split('--', 2);
    const wsSubdomain = parts[0] ?? '';
    const suffix = parts[1] ?? '';
    workspaceId = wsSubdomain.replace(/^ws-/, '').toUpperCase();

    // Check if suffix is a known sidecar alias (e.g., 'browser')
    if (isSidecarAlias(suffix)) {
      sidecar = suffix;
    } else if (/^\d+$/.test(suffix)) {
      const parsed = parseInt(suffix, 10);
      if (parsed <= 0 || parsed > 65535) {
        return { error: 'Port must be between 1 and 65535' };
      }
      targetPort = parsed;
    } else {
      return { error: `Unknown sidecar alias '${suffix}'. Valid aliases: browser` };
    }
  } else {
    workspaceId = subdomain.replace(/^ws-/, '').toUpperCase();
  }

  if (!workspaceId) {
    return { error: 'Invalid workspace subdomain' };
  }

  return { workspaceId, targetPort, sidecar };
}
