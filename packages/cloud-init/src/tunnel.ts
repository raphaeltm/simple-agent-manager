import {
  DIRECT_FIREWALL_WRITE_FILE,
  ORIGIN_CA_BOOTSTRAP_RUNCMD,
  TUNNEL_BOOTSTRAP_RUNCMD,
  TUNNEL_CONNECTOR_RUNCMD,
  TUNNEL_FIREWALL_WRITE_FILE,
  TUNNEL_WRITE_FILES,
} from './template-ingress';
import type { CloudInitVariables } from './variables';

/**
 * cloudflared releases a tunnel node may install, with the sha256 of each
 * Linux binary. Values were checked against the GitHub release asset digests
 * and the checksums published in the release notes. Add a release here (both
 * architectures) before selecting it with `cloudflaredVersion`.
 */
export const CLOUDFLARED_RELEASES: Readonly<
  Record<string, Readonly<{ amd64: string; arm64: string }>>
> = {
  '2026.10.7': {
    amd64: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872',
    arm64: '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775',
  },
};

export const DEFAULT_CLOUDFLARED_VERSION = '2026.10.7';

/** Release download prefix; the pinned checksum, not the origin, authenticates the binary. */
export const CLOUDFLARED_DOWNLOAD_BASE_URL =
  'https://github.com/cloudflare/cloudflared/releases/download';

/** Loopback port of the VM agent's tunnel listener (matches the agent's DefaultTunnelPort). */
export const DEFAULT_CLOUDFLARE_TUNNEL_PORT = '8444';

/** Seconds the connector unit waits for the tunnel listener before a start attempt fails. */
export const DEFAULT_TUNNEL_LISTENER_WAIT_SECONDS = '120';

/** Connector run tokens are base64 JSON; bound the length so a mistaken paste fails fast. */
const TUNNEL_TOKEN_RE = /^[A-Za-z0-9+/=_-]{32,4096}$/;
const NUMERIC_RE = /^[0-9]+$/;

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** A node is in tunnel mode exactly when it is given a connector token. */
export function isTunnelMode(variables: CloudInitVariables): boolean {
  return isSet(variables.cloudflareTunnelToken);
}

function effectiveVmAgentPort(variables: CloudInitVariables): string {
  if (isSet(variables.vmAgentPort)) return variables.vmAgentPort;
  return isSet(variables.originCaCertificateUrl) ? '8443' : '8080';
}

/**
 * Validate tunnel-mode variables, appending to `errors`. Error messages never
 * echo the connector token.
 */
export function validateTunnelVariables(variables: CloudInitVariables, errors: string[]): void {
  if (!isTunnelMode(variables)) {
    // Tunnel settings without a token would silently boot a direct-ingress node.
    for (const name of [
      'cloudflareTunnelPort',
      'cloudflaredVersion',
      'tunnelListenerWaitSeconds',
    ] as const) {
      if (isSet(variables[name])) {
        errors.push(`${name}: requires cloudflareTunnelToken`);
      }
    }
    return;
  }

  if (!TUNNEL_TOKEN_RE.test(variables.cloudflareTunnelToken ?? '')) {
    errors.push(
      'cloudflareTunnelToken: must be a connector run token (32-4096 base64/base64url characters)'
    );
  }
  if (isSet(variables.originCaCertificateUrl)) {
    errors.push(
      'originCaCertificateUrl: must be empty in tunnel mode (the agent is reached only through the tunnel)'
    );
  }

  const port = variables.cloudflareTunnelPort ?? DEFAULT_CLOUDFLARE_TUNNEL_PORT;
  if (!NUMERIC_RE.test(port) || Number(port) < 1 || Number(port) > 65535) {
    errors.push(`cloudflareTunnelPort: must be numeric 1-65535 (got ${JSON.stringify(port)})`);
  } else if (Number(port) === Number(effectiveVmAgentPort(variables))) {
    errors.push(
      'cloudflareTunnelPort: must differ from vmAgentPort (that listener serves the bearerless Docker Git helper)'
    );
  }

  const version = variables.cloudflaredVersion ?? DEFAULT_CLOUDFLARED_VERSION;
  if (!Object.hasOwn(CLOUDFLARED_RELEASES, version)) {
    errors.push(
      `cloudflaredVersion: must be one of ${Object.keys(CLOUDFLARED_RELEASES).join(', ')} (got ${JSON.stringify(version)})`
    );
  }

  const wait = variables.tunnelListenerWaitSeconds;
  if (isSet(wait) && (!NUMERIC_RE.test(wait) || Number(wait) < 1 || Number(wait) > 3600)) {
    errors.push(`tunnelListenerWaitSeconds: must be numeric 1-3600 (got ${JSON.stringify(wait)})`);
  }
}

/**
 * Mode-specific template blocks. Each node renders only its own ingress mode:
 * tunnel nodes never carry the Origin CA bootstrap, and direct nodes carry no
 * connector, which also keeps user-data under the 32 KB Hetzner limit.
 */
export function ingressFragments(variables: CloudInitVariables): Record<string, string> {
  const tunnel = isTunnelMode(variables);
  return {
    '{{ ingress_bootstrap_runcmd }}': tunnel ? TUNNEL_BOOTSTRAP_RUNCMD : ORIGIN_CA_BOOTSTRAP_RUNCMD,
    '{{ ingress_connector_runcmd }}': tunnel ? TUNNEL_CONNECTOR_RUNCMD : '',
    '{{ ingress_write_files }}': tunnel ? TUNNEL_WRITE_FILES : '',
    '{{ ingress_firewall_write_file }}': tunnel
      ? TUNNEL_FIREWALL_WRITE_FILE
      : DIRECT_FIREWALL_WRITE_FILE,
  };
}

/** Template replacements for tunnel mode; legacy nodes get inert values. */
export function tunnelReplacements(variables: CloudInitVariables): Record<string, string> {
  const tunnel = isTunnelMode(variables);
  const version = variables.cloudflaredVersion ?? DEFAULT_CLOUDFLARED_VERSION;
  const release = CLOUDFLARED_RELEASES[version];
  return {
    '{{ tunnel_mode }}': tunnel ? 'true' : 'false',
    // Every vm-agent start (boot, crash restart, reboot) re-applies the tunnel
    // firewall atomically first; if that fails the agent does not listen.
    '{{ vm_agent_exec_start_pre }}': tunnel
      ? 'ExecStartPre=/etc/sam/firewall/setup-firewall.sh'
      : '',
    '{{ tunnel_port }}': variables.cloudflareTunnelPort ?? DEFAULT_CLOUDFLARE_TUNNEL_PORT,
    '{{ tunnel_token }}': tunnel ? (variables.cloudflareTunnelToken ?? '') : '',
    '{{ tunnel_listener_wait_seconds }}':
      variables.tunnelListenerWaitSeconds ?? DEFAULT_TUNNEL_LISTENER_WAIT_SECONDS,
    '{{ cloudflared_url }}': `${CLOUDFLARED_DOWNLOAD_BASE_URL}/${version}/cloudflared-linux`,
    '{{ cloudflared_sha256_amd64 }}': release?.amd64 ?? '',
    '{{ cloudflared_sha256_arm64 }}': release?.arm64 ?? '',
  };
}
