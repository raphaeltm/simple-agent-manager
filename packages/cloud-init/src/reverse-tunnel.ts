import type { CloudInitVariables } from './variables';

/**
 * frp releases a reverse-tunnel node may install, with the sha256 of each Linux release
 * tarball (`frp_<version>_linux_<arch>.tar.gz`). Values were checked against the
 * `frp_sha256_checksums.txt` asset published with the GitHub release. Add a release here
 * (both architectures) before changing {@link DEFAULT_FRPC_VERSION}.
 */
export const FRPC_RELEASES: Readonly<Record<string, Readonly<{ amd64: string; arm64: string }>>> =
  {
    '0.72.0': {
      amd64: 'daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804',
      arm64: '02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf',
    },
  };

/** frp release installed on reverse-tunnel nodes; must match the box's frps major/minor. */
export const DEFAULT_FRPC_VERSION = '0.72.0';

/** Release download prefix; the pinned checksum, not the origin, authenticates the tarball. */
export const FRPC_DOWNLOAD_BASE_URL = 'https://github.com/fatedier/frp/releases/download';

/**
 * Name of the node's single frp proxy. frps reports it to the authorization plugin as
 * `<user>.<name>`, with `user` set to the node id, so the plugin can bind it to the node.
 */
export const REVERSE_TUNNEL_PROXY_NAME = 'sam-agent';

/**
 * frpc heartbeat cadence. Each heartbeat reaches the control plane's frps plugin as a `Ping`,
 * which re-checks the lease, so a released lease disconnects within about one interval.
 */
export const DEFAULT_REVERSE_TUNNEL_HEARTBEAT_INTERVAL_SECONDS = '30';
export const DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = '90';

/** base64url credential minted by the control plane (32-byte HMAC → 43 characters). */
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{32,128}$/;
const NUMERIC_RE = /^[0-9]+$/;

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

export function isReverseTunnelMode(variables: CloudInitVariables): boolean {
  return isSet(variables.reverseTunnelCredential);
}

function validPort(value: string): boolean {
  return NUMERIC_RE.test(value) && Number(value) >= 1 && Number(value) <= 65535;
}

/** Validate reverse-tunnel variables; error messages never echo the credential. */
export function validateReverseTunnelVariables(
  variables: CloudInitVariables,
  errors: string[]
): void {
  const reverseOnly = ['reverseTunnelRemotePort', 'reverseTunnelLocalPort'] as const;
  if (!isReverseTunnelMode(variables)) {
    for (const name of reverseOnly) {
      if (isSet(variables[name])) errors.push(`${name}: requires reverseTunnelCredential`);
    }
    return;
  }
  if (isSet(variables.cloudflareTunnelToken)) {
    errors.push('reverseTunnelCredential: cannot be combined with cloudflareTunnelToken');
  }
  if (!CREDENTIAL_RE.test(variables.reverseTunnelCredential ?? '')) {
    errors.push('reverseTunnelCredential: must be 32-128 base64url characters');
  }
  if (!isSet(variables.nodeRuntimeIncarnationId)) {
    errors.push('nodeRuntimeIncarnationId: required in reverse-tunnel mode (the frps plugin binds it)');
  }
  if (isSet(variables.originCaCertificateUrl)) {
    errors.push(
      'originCaCertificateUrl: must be empty in reverse-tunnel mode (the agent is reached only through the tunnel)'
    );
  }
  const remote = variables.reverseTunnelRemotePort ?? '';
  if (!validPort(remote)) {
    errors.push(
      `reverseTunnelRemotePort: must be numeric 1-65535 (got ${JSON.stringify(remote)})`
    );
  }
}

/** Host and port frpc dials: the control plane's own public HTTPS endpoint. */
export function reverseTunnelServerAddress(controlPlaneUrl: string): {
  host: string;
  port: string;
} {
  try {
    const url = new URL(controlPlaneUrl);
    return { host: url.hostname, port: url.port || '443' };
  } catch {
    // validateCloudInitVariables already rejected an unparseable control plane URL.
    return { host: '', port: '443' };
  }
}

/** Template replacements for reverse-tunnel mode; other nodes get inert values. */
export function reverseTunnelReplacements(variables: CloudInitVariables): Record<string, string> {
  const reverse = isReverseTunnelMode(variables);
  const release = FRPC_RELEASES[DEFAULT_FRPC_VERSION];
  const server = reverseTunnelServerAddress(variables.controlPlaneUrl);
  return {
    '{{ reverse_tunnel_credential }}': reverse ? (variables.reverseTunnelCredential ?? '') : '',
    '{{ reverse_tunnel_remote_port }}': reverse ? (variables.reverseTunnelRemotePort ?? '') : '',
    '{{ reverse_tunnel_server_addr }}': server.host,
    '{{ reverse_tunnel_server_port }}': server.port,
    '{{ reverse_tunnel_proxy_name }}': REVERSE_TUNNEL_PROXY_NAME,
    '{{ reverse_tunnel_heartbeat_interval_seconds }}':
      DEFAULT_REVERSE_TUNNEL_HEARTBEAT_INTERVAL_SECONDS,
    '{{ reverse_tunnel_heartbeat_timeout_seconds }}':
      DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
    '{{ frpc_version }}': DEFAULT_FRPC_VERSION,
    '{{ frpc_url }}': `${FRPC_DOWNLOAD_BASE_URL}/v${DEFAULT_FRPC_VERSION}`,
    '{{ frpc_sha256_amd64 }}': release?.amd64 ?? '',
    '{{ frpc_sha256_arm64 }}': release?.arm64 ?? '',
  };
}
