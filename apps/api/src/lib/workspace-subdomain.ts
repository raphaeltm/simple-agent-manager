/**
 * Parsed workspace subdomain result.
 * Pattern: ws-{id}.{domain} or ws-{id}--{port}.{domain}
 */
export interface WorkspaceSubdomain {
  workspaceId: string;
  targetPort: number | null;
}

/**
 * Parse a workspace subdomain into workspace ID and optional port.
 *
 * @param hostname - Full hostname (e.g., "ws-abc123--3000.example.com")
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

  if (subdomain.includes('--')) {
    const parts = subdomain.split('--', 2);
    const wsSubdomain = parts[0] ?? '';
    const portStr = parts[1] ?? '';
    workspaceId = wsSubdomain.replace(/^ws-/, '').toUpperCase();
    const parsed = parseInt(portStr, 10);
    if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
      return { error: 'Port must be between 1 and 65535' };
    }
    targetPort = parsed;
  } else {
    workspaceId = subdomain.replace(/^ws-/, '').toUpperCase();
  }

  if (!workspaceId) {
    return { error: 'Invalid workspace subdomain' };
  }

  return { workspaceId, targetPort };
}
