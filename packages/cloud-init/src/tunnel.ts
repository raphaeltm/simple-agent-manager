import {
  DIRECT_FIREWALL_WRITE_FILE,
  ORIGIN_CA_BOOTSTRAP_RUNCMD,
  TUNNEL_BOOTSTRAP_RUNCMD,
  TUNNEL_CONNECTOR_RUNCMD,
  TUNNEL_FIREWALL_WRITE_FILE,
  TUNNEL_WRITE_FILES,
} from './template-ingress';
import {
  isReverseTunnelMode,
  reverseTunnelReplacements,
  validateReverseTunnelVariables,
} from './reverse-tunnel';
import {
  REVERSE_TUNNEL_BOOTSTRAP_RUNCMD,
  REVERSE_TUNNEL_CONNECTOR_RUNCMD,
  REVERSE_TUNNEL_WRITE_FILES,
} from './template-reverse-tunnel';
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

/** Elapsed seconds the connector unit waits for the tunnel listener before a start attempt fails. */
export const DEFAULT_TUNNEL_LISTENER_WAIT_SECONDS = '120';

/** Timeout of each loopback tunnel listener health probe, in seconds. */
export const DEFAULT_TUNNEL_LISTENER_PROBE_TIMEOUT_SECONDS = '2';

/** Pause between loopback tunnel listener health probes, in seconds. */
export const DEFAULT_TUNNEL_LISTENER_PROBE_INTERVAL_SECONDS = '1';

/** systemd RestartSec for the connector after it exits or fails to start. */
export const DEFAULT_TUNNEL_CONNECTOR_RESTART_SECONDS = '5';

/** Tunnel timing settings: [variable, inclusive maximum]. All must be integers >= 1. */
const TUNNEL_TIMING_LIMITS = [
  ['tunnelListenerWaitSeconds', 3600],
  ['tunnelListenerProbeTimeoutSeconds', 60],
  ['tunnelListenerProbeIntervalSeconds', 60],
  ['tunnelConnectorRestartSeconds', 3600],
] as const;

/** Connector run tokens are base64 JSON; bound the length so a mistaken paste fails fast. */
const TUNNEL_TOKEN_RE = /^[A-Za-z0-9+/=_-]{32,4096}$/;
const NUMERIC_RE = /^[0-9]+$/;

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** Empty strings mean "not set": env-derived callers commonly pass ''. */
function orDefault(value: string | undefined, fallback: string): string {
  return isSet(value) ? value : fallback;
}

function isCloudflareTunnelMode(variables: CloudInitVariables): boolean {
  return isSet(variables.cloudflareTunnelToken);
}

/**
 * A node is in tunnel mode exactly when it is given a Cloudflare connector token or a
 * reverse-tunnel credential. Both modes share the firewall and the loopback listener.
 */
export function isTunnelMode(variables: CloudInitVariables): boolean {
  return isCloudflareTunnelMode(variables) || isReverseTunnelMode(variables);
}

/** The agent's loopback tunnel listener port for whichever tunnel mode is active. */
function tunnelListenerPort(variables: CloudInitVariables): string {
  return isReverseTunnelMode(variables)
    ? orDefault(variables.reverseTunnelLocalPort, DEFAULT_CLOUDFLARE_TUNNEL_PORT)
    : orDefault(variables.cloudflareTunnelPort, DEFAULT_CLOUDFLARE_TUNNEL_PORT);
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
  validateReverseTunnelVariables(variables, errors);
  if (isReverseTunnelMode(variables)) {
    for (const name of ['cloudflareTunnelPort', 'cloudflaredVersion'] as const) {
      if (isSet(variables[name])) errors.push(`${name}: requires cloudflareTunnelToken`);
    }
    validateListenerPort(variables, 'reverseTunnelLocalPort', errors);
    validateTunnelTimings(variables, errors);
    return;
  }
  if (!isCloudflareTunnelMode(variables)) {
    // Tunnel settings without a token would silently boot a direct-ingress node.
    const tunnelOnly: Array<keyof CloudInitVariables> = [
      'cloudflareTunnelPort',
      'cloudflaredVersion',
      ...TUNNEL_TIMING_LIMITS.map(([timing]) => timing),
    ];
    for (const name of tunnelOnly) {
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

  validateListenerPort(variables, 'cloudflareTunnelPort', errors);

  const version = orDefault(variables.cloudflaredVersion, DEFAULT_CLOUDFLARED_VERSION);
  if (!Object.hasOwn(CLOUDFLARED_RELEASES, version)) {
    errors.push(
      `cloudflaredVersion: must be one of ${Object.keys(CLOUDFLARED_RELEASES).join(', ')} (got ${JSON.stringify(version)})`
    );
  }

  validateTunnelTimings(variables, errors);
}

function validateListenerPort(
  variables: CloudInitVariables,
  name: 'cloudflareTunnelPort' | 'reverseTunnelLocalPort',
  errors: string[]
): void {
  const port = orDefault(variables[name], DEFAULT_CLOUDFLARE_TUNNEL_PORT);
  if (!NUMERIC_RE.test(port) || Number(port) < 1 || Number(port) > 65535) {
    errors.push(`${name}: must be numeric 1-65535 (got ${JSON.stringify(port)})`);
  } else if (Number(port) === Number(effectiveVmAgentPort(variables))) {
    errors.push(
      `${name}: must differ from vmAgentPort (that listener serves the bearerless Docker Git helper)`
    );
  }
}

function validateTunnelTimings(variables: CloudInitVariables, errors: string[]): void {
  for (const [name, max] of TUNNEL_TIMING_LIMITS) {
    const value = variables[name];
    if (isSet(value) && (!NUMERIC_RE.test(value) || Number(value) < 1 || Number(value) > max)) {
      errors.push(`${name}: must be numeric 1-${max} (got ${JSON.stringify(value)})`);
    }
  }
}

/**
 * Mode-specific template blocks. Each node renders only its own ingress mode:
 * tunnel nodes never carry the Origin CA bootstrap, and direct nodes carry no
 * connector, which also keeps user-data under the 32 KB Hetzner limit.
 */
export function ingressFragments(variables: CloudInitVariables): Record<string, string> {
  if (isReverseTunnelMode(variables)) {
    return {
      '{{ ingress_bootstrap_runcmd }}': REVERSE_TUNNEL_BOOTSTRAP_RUNCMD,
      '{{ ingress_connector_runcmd }}': REVERSE_TUNNEL_CONNECTOR_RUNCMD,
      '{{ ingress_write_files }}': REVERSE_TUNNEL_WRITE_FILES,
      '{{ ingress_firewall_write_file }}': TUNNEL_FIREWALL_WRITE_FILE,
    };
  }
  const tunnel = isCloudflareTunnelMode(variables);
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
  const cloudflare = isCloudflareTunnelMode(variables);
  const version = orDefault(variables.cloudflaredVersion, DEFAULT_CLOUDFLARED_VERSION);
  const release = CLOUDFLARED_RELEASES[version];
  return {
    '{{ tunnel_mode }}': tunnel ? 'true' : 'false',
    // Every vm-agent start (boot, crash restart, reboot) re-applies the tunnel
    // firewall atomically first; if that fails the agent does not listen.
    '{{ vm_agent_exec_start_pre }}': tunnel
      ? 'ExecStartPre=/etc/sam/firewall/setup-firewall.sh'
      : '',
    '{{ tunnel_port }}': tunnelListenerPort(variables),
    '{{ tunnel_token }}': cloudflare ? (variables.cloudflareTunnelToken ?? '') : '',
    '{{ tunnel_listener_wait_seconds }}': orDefault(
      variables.tunnelListenerWaitSeconds,
      DEFAULT_TUNNEL_LISTENER_WAIT_SECONDS
    ),
    '{{ tunnel_listener_probe_timeout_seconds }}': orDefault(
      variables.tunnelListenerProbeTimeoutSeconds,
      DEFAULT_TUNNEL_LISTENER_PROBE_TIMEOUT_SECONDS
    ),
    '{{ tunnel_listener_probe_interval_seconds }}': orDefault(
      variables.tunnelListenerProbeIntervalSeconds,
      DEFAULT_TUNNEL_LISTENER_PROBE_INTERVAL_SECONDS
    ),
    '{{ tunnel_connector_restart_seconds }}': orDefault(
      variables.tunnelConnectorRestartSeconds,
      DEFAULT_TUNNEL_CONNECTOR_RESTART_SECONDS
    ),
    '{{ cloudflared_url }}': `${CLOUDFLARED_DOWNLOAD_BASE_URL}/${version}/cloudflared-linux`,
    '{{ cloudflared_sha256_amd64 }}': release?.amd64 ?? '',
    '{{ cloudflared_sha256_arm64 }}': release?.arm64 ?? '',
    ...reverseTunnelReplacements(variables),
  };
}
