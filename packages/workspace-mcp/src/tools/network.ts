/**
 * Network & Connectivity tools — highest daily friction.
 *
 * - get_network_info: base domain, workspace URL, exposed ports
 * - expose_port: register a port, return external URL
 * - check_dns_status: DNS propagation and TLS cert status
 */

import { exec } from 'node:child_process';
import * as dns from 'node:dns';
import * as tls from 'node:tls';
import { promisify } from 'node:util';

import type { ApiClient } from '../api-client.js';
import type { WorkspaceMcpConfig } from '../config.js';

/** Default timeout for shell exec commands (ms). Override via SAM_EXEC_TIMEOUT_MS. */
const DEFAULT_EXEC_TIMEOUT_MS = 5000;
const EXEC_TIMEOUT_MS = parseInt(
  process.env['SAM_EXEC_TIMEOUT_MS'] ?? String(DEFAULT_EXEC_TIMEOUT_MS),
  10,
);

/** Default timeout for port-check commands (ms). Override via SAM_PORT_CHECK_TIMEOUT_MS. */
const DEFAULT_PORT_CHECK_TIMEOUT_MS = 3000;
const PORT_CHECK_TIMEOUT_MS = parseInt(
  process.env['SAM_PORT_CHECK_TIMEOUT_MS'] ?? String(DEFAULT_PORT_CHECK_TIMEOUT_MS),
  10,
);

/** Default timeout for TLS certificate checks (ms). Override via SAM_TLS_CHECK_TIMEOUT_MS. */
const DEFAULT_TLS_CHECK_TIMEOUT_MS = 5000;
const TLS_CHECK_TIMEOUT_MS = parseInt(
  process.env['SAM_TLS_CHECK_TIMEOUT_MS'] ?? String(DEFAULT_TLS_CHECK_TIMEOUT_MS),
  10,
);

const execAsync = promisify(exec);
const dnsResolve4 = promisify(dns.resolve4);

interface PortInfo {
  port: number;
  pid: number | null;
  process: string;
  externalUrl: string;
}

/**
 * Discover listening TCP ports from inside the workspace.
 */
async function discoverListeningPorts(
  config: WorkspaceMcpConfig,
): Promise<PortInfo[]> {
  try {
    // Use ss to find listening TCP ports (works in most containers)
    const { stdout } = await execAsync(
      'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo ""',
      { timeout: EXEC_TIMEOUT_MS },
    );
    if (!stdout.trim()) return [];

    const ports: PortInfo[] = [];
    const seen = new Set<number>();

    for (const line of stdout.split('\n')) {
      // Match ss output: LISTEN ... *:PORT or [::]:PORT ... users:(("process",pid=123,...))
      const portMatch = line.match(
        /(?:\*|0\.0\.0\.0|::|\[::\]):(\d+)\s/,
      );
      if (!portMatch) continue;

      const portStr = portMatch[1];
      if (!portStr) continue;
      const port = parseInt(portStr, 10);
      if (seen.has(port) || port === 0) continue;
      seen.add(port);

      // Extract process name and PID if available
      const procMatch = line.match(
        /users:\(\("([^"]+)",pid=(\d+)/,
      );
      const processName = procMatch?.[1] ?? 'unknown';
      const pid = procMatch?.[2] ? parseInt(procMatch[2], 10) : null;

      const externalUrl = config.workspaceId && config.baseDomain
        ? `https://ws-${config.workspaceId}--${port}.${config.baseDomain}`
        : '';

      ports.push({ port, pid, process: processName, externalUrl });
    }

    return ports.sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

export async function getNetworkInfo(
  config: WorkspaceMcpConfig,
  _apiClient: ApiClient,
) {
  const ports = await discoverListeningPorts(config);

  return {
    baseDomain: config.baseDomain,
    workspaceUrl: config.workspaceUrl,
    workspaceId: config.workspaceId,
    portUrlPattern: config.workspaceId && config.baseDomain
      ? `https://ws-${config.workspaceId}--{PORT}.${config.baseDomain}`
      : 'unavailable (workspace ID or base domain not set)',
    listeningPorts: ports,
    hint: 'Use expose_port to register a specific port and get its external URL.',
  };
}

export async function exposePort(
  config: WorkspaceMcpConfig,
  _apiClient: ApiClient,
  args: { port: number; label?: string },
) {
  const { port, label } = args;

  if (port < 1 || port > 65535) {
    return { error: 'Port must be between 1 and 65535' };
  }

  // The external URL follows the SAM workspace port pattern
  if (!config.workspaceId || !config.baseDomain) {
    return {
      error: 'Cannot construct external URL: workspace ID or base domain not available',
      hint: 'SAM_WORKSPACE_ID and SAM_API_URL environment variables must be set',
    };
  }

  const externalUrl = `https://ws-${config.workspaceId}--${port}.${config.baseDomain}`;

  // Check if something is actually listening on this port
  let isListening = false;
  try {
    const { stdout } = await execAsync(
      `ss -tlnp sport = :${port} 2>/dev/null || echo ""`,
      { timeout: PORT_CHECK_TIMEOUT_MS },
    );
    isListening = stdout.includes(`:${port}`);
  } catch {
    // Can't verify, proceed anyway
  }

  return {
    port,
    label: label ?? null,
    externalUrl,
    isListening,
    note: isListening
      ? 'Port is active and accessible via the external URL (Cloudflare proxied).'
      : 'No process is currently listening on this port. Start your server first.',
  };
}

export async function checkDnsStatus(
  config: WorkspaceMcpConfig,
  _apiClient: ApiClient,
) {
  if (!config.workspaceUrl) {
    return {
      error: 'Workspace URL not available',
      hint: 'SAM_WORKSPACE_URL environment variable must be set',
    };
  }

  let hostname: string;
  try {
    hostname = new URL(config.workspaceUrl).hostname;
  } catch {
    return { error: `Invalid workspace URL: ${config.workspaceUrl}` };
  }

  // DNS resolution check
  let dnsResolved = false;
  let ipAddresses: string[] = [];
  try {
    ipAddresses = await dnsResolve4(hostname);
    dnsResolved = ipAddresses.length > 0;
  } catch {
    dnsResolved = false;
  }

  // TLS certificate check
  let tlsValid = false;
  let tlsError: string | null = null;
  let tlsExpiry: string | null = null;

  if (dnsResolved) {
    try {
      const tlsResult = await new Promise<{
        valid: boolean;
        expiry: string | null;
        error: string | null;
      }>((resolve) => {
        const socket = tls.connect(
          {
            host: hostname,
            port: 443,
            servername: hostname,
            timeout: TLS_CHECK_TIMEOUT_MS,
          },
          () => {
            const cert = socket.getPeerCertificate();
            const authorized = socket.authorized;
            socket.destroy();
            resolve({
              valid: authorized,
              expiry: cert.valid_to ?? null,
              error: authorized ? null : 'Certificate not authorized',
            });
          },
        );
        socket.on('error', (err) => {
          socket.destroy();
          resolve({
            valid: false,
            expiry: null,
            error: err.message,
          });
        });
        socket.setTimeout(TLS_CHECK_TIMEOUT_MS, () => {
          socket.destroy();
          resolve({
            valid: false,
            expiry: null,
            error: 'TLS connection timeout',
          });
        });
      });
      tlsValid = tlsResult.valid;
      tlsExpiry = tlsResult.expiry;
      tlsError = tlsResult.error;
    } catch (err) {
      tlsError = err instanceof Error ? err.message : 'Unknown TLS error';
    }
  }

  return {
    hostname,
    dnsResolved,
    ipAddresses,
    tlsValid,
    tlsExpiry,
    tlsError,
    status: dnsResolved && tlsValid
      ? 'healthy'
      : dnsResolved
        ? 'dns_ok_tls_error'
        : 'dns_not_resolved',
    hint: !dnsResolved
      ? 'DNS has not propagated yet. This usually takes 1-2 minutes after workspace creation.'
      : !tlsValid
        ? 'DNS is resolved but TLS certificate is not valid. Cloudflare may still be provisioning the certificate.'
        : 'Workspace is fully reachable with valid TLS.',
  };
}
