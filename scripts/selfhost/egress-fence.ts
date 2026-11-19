/**
 * The celld egress fence: an nftables table that limits where the celld process may connect.
 *
 * celld runs the API Worker on the host network, so without a fence Worker code can reach every
 * loopback service on the box (celld's unauthenticated operator listener, frps's control port,
 * the object store and its console), every private address, and the cloud metadata server. The
 * API checks the URLs it is given (packages/worker-core/src/network-hosts), but a name that resolves to a
 * private address, or a code path that one day misses the check, needs a control that holds
 * anyway. The kernel is that control.
 *
 * celld runs as a dedicated uid (CELLD_UID). The fence matches that uid's sockets in the host's
 * OUTPUT hook and lets them reach only:
 * - the public internet;
 * - the DNS servers in /etc/resolv.conf, on port 53;
 * - the node tunnel lease ports on 127.0.0.1 (frps binds them there);
 * - the object store endpoint celld itself uses, when that is on this box or the private network;
 * - the GCE metadata token proxy, when the bucket is gs:// (see metadataProxy below);
 * - Caddy's HTTP and HTTPS ports on this host's own non-loopback addresses (what the internet sees).
 *
 * Everything else on this host, and every private, link-local, metadata, reserved and IPv6
 * transition range, is rejected with an ICMP administratively-prohibited error. connect() then
 * fails with EHOSTUNREACH ("No route to host"; EACCES for IPv6) on the first SYN retransmit,
 * about a second in, and a UDP send fails at once with EPERM. A plain `drop` would not do: a
 * dropped TCP SYN in OUTPUT is retransmitted until connect() times out (measured on a 6.8
 * kernel), and a timeout cannot be told apart from a slow host. The distinct errors are how the
 * verify command and the celld start check tell "fenced" from "nothing listening"
 * (fence-probes.ts).
 *
 * Worker code and celld's own storage client are one process, so the fence cannot tell them
 * apart: whatever celld needs, the Worker can reach too. That is why the object store is allowed
 * only at its exact address and port, and why the metadata server sits behind a proxy that
 * accepts only the native celld socket uid and returns only a fleet-bucket CAB token. The SAM
 * API Worker is trusted with fleet authority; safety does not depend on hiding the proxy path.
 * Pinned runtime isolation evidence: live/metadata-proxy.live.test.ts (exact native canary
 * comparison, empty process.env keys, inaccessible host/proc files and process execution).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { PortRange } from './box-settings.js';
import { assertOpenable, FORBIDDEN_IPV4, FORBIDDEN_IPV6 } from './fence-addresses.js';
export { FORBIDDEN_IPV4, FORBIDDEN_IPV6 } from './fence-addresses.js';
import { formatProbes, startCheckProbes } from './fence-probes.js';
/** nftables table name; the start check and the verify command look for it. */
export const EGRESS_FENCE_TABLE = 'sam_celld_egress';

/** uid (and gid) celld runs as; the fence matches its sockets. */
export const DEFAULT_CELLD_UID = 7103;

/** Storage scope selects CAB objectViewer or objectAdmin on the fleet bucket only.
 * No token from the metadata server is ever returned directly (metadata-proxy/token.ts).
 */
export const DEFAULT_GCE_METADATA_PROXY_SCOPES =
  'https://www.googleapis.com/auth/devstorage.read_write';

/** Scopes GCE_METADATA_PROXY_SCOPES may name: Cloud Storage ones only. */
const STORAGE_SCOPE = /^https:\/\/www\.googleapis\.com\/auth\/devstorage\.(read_only|read_write)$/;

/** The proxy's forced scopes; anything but Cloud Storage scopes is refused. */
export function metadataProxyScopes(box: Readonly<Record<string, string>>): string {
  const raw = box.GCE_METADATA_PROXY_SCOPES?.trim() || DEFAULT_GCE_METADATA_PROXY_SCOPES;
  const scopes = raw.split(',').map((scope) => scope.trim());
  const bad = scopes.find((scope) => !STORAGE_SCOPE.test(scope));
  if (bad !== undefined) {
    throw new Error(`GCE_METADATA_PROXY_SCOPES: "${bad}" is not a Cloud Storage scope`);
  }
  if (scopes.length !== 1)
    throw new Error('GCE_METADATA_PROXY_SCOPES requires exactly one storage scope');
  return scopes[0] ?? DEFAULT_GCE_METADATA_PROXY_SCOPES;
}

/** Loopback port of the GCE metadata token proxy (profile `gce`). */
export const DEFAULT_GCE_METADATA_PROXY_PORT = 7180;

/** The verdict for everything the fence refuses (see the header for why not `drop`). */
const REFUSE = 'counter reject with icmpx admin-prohibited';

/** Ports docker-compose.yml defaults to; the fence must refuse the same listeners. */
const COMPOSE_PORT_DEFAULTS = {
  CELLD_PORT: 8080,
  CELLD_INTERNAL_PORT: 7001,
  FRPS_BIND_PORT: 7000,
  OBJECTSTORE_PORT: 9000,
  OBJECTSTORE_CONSOLE_PORT: 9001,
  HTTP_PORT: 80,
  HTTPS_PORT: 443,
} as const;

type ComposePort = keyof typeof COMPOSE_PORT_DEFAULTS;

export interface FenceEndpoint {
  address: string;
  port: number;
}

export interface EgressFencePlan {
  celldUid: number;
  leaseRange: PortRange;
  /** Single TCP ports celld may reach on 127.0.0.1. */
  loopbackPorts: number[];
  /** Addresses (with port) celld may reach even though they are private or on this host. */
  endpoints: FenceEndpoint[];
  dnsServers: string[];
  /** Caddy's ports on this host's own addresses. */
  localPublicPorts: number[];
  /** The listeners the plan must never allow; checked by assertFencePlan. */
  forbiddenLoopbackPorts: Record<string, number>;
  /** This host's own addresses: an endpoint on one of them is checked like a loopback one. */
  localAddresses: string[];
}

function intSetting(raw: string | undefined, fallback: number, name: string, min = 1): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > 65535) {
    throw new Error(`${name} must be an integer between ${min} and 65535`);
  }
  return value;
}

export function composePort(box: Readonly<Record<string, string>>, name: ComposePort): number {
  return intSetting(box[name], COMPOSE_PORT_DEFAULTS[name], name);
}

export function celldUid(box: Readonly<Record<string, string>>): number {
  const uid = intSetting(box.CELLD_UID, DEFAULT_CELLD_UID, 'CELLD_UID', 1000);
  if ([7101, Number(box.SAM_MX_UID || 7102), 65532, 65534].includes(uid)) {
    throw new Error('CELLD_UID collides with another box service identity');
  }
  return uid;
}

/** Whether the GCE metadata token proxy runs: on for a gs:// bucket unless turned off. */
export function metadataProxyEnabled(box: Readonly<Record<string, string>>): boolean {
  const setting = (box.GCE_METADATA_PROXY ?? '').toLowerCase();
  if (setting === 'off' || setting === 'false' || setting === '0') return false;
  if (setting === 'on' || setting === 'true' || setting === '1') return true;
  return (box.CELLD_BUCKET ?? '').startsWith('gs://');
}

export function metadataProxyPort(box: Readonly<Record<string, string>>): number {
  return intSetting(
    box.GCE_METADATA_PROXY_PORT,
    DEFAULT_GCE_METADATA_PROXY_PORT,
    'GCE_METADATA_PROXY_PORT',
    1024
  );
}

/** Nameservers from resolv.conf text, IP literals only (zone ids dropped). */
export function parseNameservers(resolvConf: string): string[] {
  const servers = resolvConf
    .split('\n')
    .map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1]?.split('%')[0] ?? '')
    .filter((address) => isIP(address) !== 0);
  return [...new Set(servers)];
}

function defaultPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** The S3 endpoint celld uses, resolved to addresses. Null when none is set (gs://, AWS). */
export async function resolveObjectStoreEndpoints(
  box: Readonly<Record<string, string>>,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((entry) => entry.address)
): Promise<FenceEndpoint[]> {
  const raw = box.S3_ENDPOINT;
  if (!raw) return [];
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0) throw new Error(`S3_ENDPOINT host ${host} did not resolve`);
  // Checked on the resolved addresses: a name pointing at 169.254.169.254 is refused too.
  for (const address of addresses) assertOpenable(address, `S3_ENDPOINT (${host})`);
  return addresses.map((address) => ({ address, port: defaultPort(url) }));
}

export interface FencePlanInput {
  box: Readonly<Record<string, string>>;
  leaseRange: PortRange;
  resolvConf: string;
  objectStore: FenceEndpoint[];
  /** Other box services celld must reach (the mail collector's SMTP port: mailEgressEndpoints). */
  serviceEndpoints?: FenceEndpoint[];
  /** This host's interface addresses (os.networkInterfaces()). */
  localAddresses?: string[];
}

/**
 * SAM_EGRESS_ALLOW: extra `address:port` pairs celld may reach (IP literals; IPv6 in brackets),
 * comma-separated. For an endpoint an admin opted in to on the private network, such as a local
 * model server for `llm.openAICompatible.allowPrivateNetwork`. Names are refused: the fence
 * matches addresses, and a name could later resolve elsewhere.
 */
export function parseAllowedEndpoints(raw: string | undefined): FenceEndpoint[] {
  if (!raw?.trim()) return [];
  return raw.split(',').map((entry) => {
    const match = /^\s*(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):(\d{1,5})\s*$/.exec(entry);
    const address = match?.[1] ?? match?.[2] ?? '';
    const port = Number(match?.[3]);
    if (!match || isIP(address) === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`SAM_EGRESS_ALLOW entry "${entry.trim()}" must be IP:PORT or [IPv6]:PORT`);
    }
    assertOpenable(address, `SAM_EGRESS_ALLOW entry "${entry.trim()}"`);
    return { address, port };
  });
}

export function buildFencePlan({
  box,
  leaseRange,
  resolvConf,
  objectStore,
  serviceEndpoints = [],
  localAddresses,
}: FencePlanInput): EgressFencePlan {
  const loopbackPorts: number[] = [];
  const endpoints: FenceEndpoint[] = [];
  const allowed = parseAllowedEndpoints(box.SAM_EGRESS_ALLOW);
  for (const endpoint of [...objectStore, ...serviceEndpoints, ...allowed]) {
    // The one choke point for every endpoint the fence opens, whatever produced it.
    assertOpenable(endpoint.address, 'egress fence endpoint');
    if (endpoint.port === 2019)
      throw new Error('egress fence never opens the Caddy admin port (2019)');
    if (endpoint.address === '127.0.0.1') loopbackPorts.push(endpoint.port);
    else endpoints.push(endpoint);
  }
  if (metadataProxyEnabled(box)) loopbackPorts.push(metadataProxyPort(box));
  const dnsServers = parseNameservers(resolvConf);
  if (dnsServers.length === 0) throw new Error('no nameserver in resolv.conf; celld needs DNS');
  const plan: EgressFencePlan = {
    celldUid: celldUid(box),
    leaseRange,
    loopbackPorts: [...new Set(loopbackPorts)]
      .filter((port) => !inRange(port, leaseRange))
      .sort((a, b) => a - b),
    endpoints,
    dnsServers,
    localPublicPorts: [composePort(box, 'HTTP_PORT'), composePort(box, 'HTTPS_PORT')],
    forbiddenLoopbackPorts: {
      CADDY_ADMIN_PORT: 2019,
      CELLD_PORT: composePort(box, 'CELLD_PORT'),
      CELLD_INTERNAL_PORT: composePort(box, 'CELLD_INTERNAL_PORT'),
      FRPS_BIND_PORT: composePort(box, 'FRPS_BIND_PORT'),
      OBJECTSTORE_CONSOLE_PORT: composePort(box, 'OBJECTSTORE_CONSOLE_PORT'),
    },
    localAddresses: localAddresses ?? [],
  };
  assertFencePlan(plan);
  return plan;
}

function inRange(port: number, range: PortRange): boolean {
  return port >= range.start && port <= range.end;
}

function isLoopback(address: string): boolean {
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.') ||
    /^::ffff:7f[0-9a-f]{2}:/i.test(address)
  );
}

/**
 * Fails when the plan would let celld reach a listener it must never reach: its own public and
 * operator listeners, frps's control port, the object store console. An overlap means the box
 * is misconfigured (two services on one port), and the fence refuses rather than opening it.
 */
export function assertFencePlan(plan: EgressFencePlan): void {
  const local = new Set(plan.localAddresses);
  for (const [name, port] of Object.entries(plan.forbiddenLoopbackPorts)) {
    if (plan.loopbackPorts.includes(port) || inRange(port, plan.leaseRange)) {
      throw new Error(`egress fence would allow ${name} (${port}); change the conflicting port`);
    }
    if (plan.localPublicPorts.includes(port)) {
      throw new Error(`${name} (${port}) collides with Caddy's port`);
    }
    // celld and frps listen on loopback only today, but an endpoint on another local address
    // (127.0.0.2, the box's own IP) on one of these ports would reach a listener bound there.
    const opened = plan.endpoints.find(
      (endpoint) =>
        endpoint.port === port && (isLoopback(endpoint.address) || local.has(endpoint.address))
    );
    if (opened) {
      throw new Error(`egress fence would allow ${name} (${opened.address}:${port}); refusing`);
    }
  }
}

function addressFamily(address: string): 'ip' | 'ip6' {
  return isIP(address) === 6 ? 'ip6' : 'ip';
}

function nftSet(values: Array<string | number>): string {
  return values.length === 1 ? String(values[0]) : `{ ${values.join(', ')} }`;
}

/** The DNS accept rules for `servers` (fence.sh renders the same lines from resolv.conf). */
export function renderDnsRules(servers: readonly string[]): string[] {
  return (['ip', 'ip6'] as const).flatMap((family) => {
    const own = servers.filter((server) => addressFamily(server) === family);
    return own.length === 0
      ? []
      : [
          `${family} daddr { ${own.join(', ')} } meta l4proto { tcp, udp } th dport 53 accept comment "DNS"`,
        ];
  });
}

/** The nftables ruleset for `plan`; applied atomically (create, delete, define) by `nft -f`. */
export function renderFenceRuleset(plan: EgressFencePlan): string {
  const loopback = [`${plan.leaseRange.start}-${plan.leaseRange.end}`, ...plan.loopbackPorts];
  const caddy = nftSet(plan.localPublicPorts);
  const allowLines = [
    // The fence service keeps chain `dns` equal to the nameservers celld's resolv.conf names
    // (deploy/selfhost/egress-fence/fence.sh), so a resolver change cannot cut DNS silently.
    'jump dns',
    `ip daddr 127.0.0.1 tcp dport ${nftSet(loopback)} accept comment "node tunnel leases and allowed local endpoints"`,
    ...plan.endpoints.map(
      (endpoint) =>
        `${addressFamily(endpoint.address)} daddr ${endpoint.address} tcp dport ${endpoint.port} accept comment "object store or allowed endpoint"`
    ),
    // Worker requests to the install's own hostnames (check_dns_status probes
    // https://ws-<id>.<domain>) reach Caddy at the box's own address when that address is on an
    // interface (a public IP on the NIC, or a LAN install). Loopback is not that path.
    `ip daddr != 127.0.0.0/8 fib daddr type local tcp dport ${caddy} accept comment "Caddy on this host's own addresses"`,
    `ip6 daddr != ::1 fib daddr type local tcp dport ${caddy} accept comment "Caddy on this host's own addresses"`,
  ];
  const body = [
    'ct direction reply ct state established,related accept',
    ...allowLines,
    `fib daddr type local ${REFUSE} comment "anything else on this host"`,
    `ip daddr ${nftSet(FORBIDDEN_IPV4)} ${REFUSE} comment "private, link-local, metadata, reserved"`,
    `ip6 daddr ${nftSet(FORBIDDEN_IPV6)} ${REFUSE} comment "private, link-local, transition, reserved"`,
  ];
  return [
    '#!/usr/sbin/nft -f',
    '# Generated by `pnpm selfhost:deploy` (scripts/selfhost/egress-fence.ts). Do not edit.',
    `table inet ${EGRESS_FENCE_TABLE}`,
    `delete table inet ${EGRESS_FENCE_TABLE}`,
    `table inet ${EGRESS_FENCE_TABLE} {`,
    // Anonymous sets in a chain of their own, not named sets: Debian 12's nft 1.0.6 crashes
    // listing a named set that a newer nft (the fence image's) created.
    '  chain dns {',
    ...renderDnsRules(plan.dnsServers).map((line) => `    ${line}`),
    '  }',
    '  chain output {',
    '    type filter hook output priority filter; policy accept;',
    `    meta skuid ${plan.celldUid} jump celld`,
    '  }',
    '  chain celld {',
    ...body.map((line) => `    ${line}`),
    '  }',
    '}',
    '',
  ].join('\n');
}

/** celld.env: the start check's canary and, on a gs:// bucket, the metadata token proxy. */
export function renderCelldEnv(
  box: Readonly<Record<string, string>>,
  plan: EgressFencePlan,
  metadataProxySecret: string
): string {
  const values: Record<string, string> = {
    // celld's start and periodic checks connect to each and require the fence to reject every
    // one: a missing rule class keeps celld from starting, or stops it (deploy/selfhost/celld/start.sh).
    SAM_EGRESS_FENCE_PROBES: formatProbes(startCheckProbes(plan)),
  };
  if (metadataProxyEnabled(box)) {
    if (!/^[0-9a-f]{64}$/.test(metadataProxySecret)) {
      throw new Error('metadata proxy secret must be 32 bytes of lowercase hex');
    }
    // object_store builds http://{GCE_METADATA_HOST}/computeMetadata/v1/..., so the secret path
    // prefix travels in the host value. Worker code cannot read celld's environment.
    const host = `127.0.0.1:${metadataProxyPort(box)}/${metadataProxySecret}`;
    values.GCE_METADATA_HOST = host;
    values.GCE_METADATA_IP = host;
    values.GCE_METADATA_PROXY_SECRET = metadataProxySecret;
    values.GCE_METADATA_PROXY_PORT = String(metadataProxyPort(box));
    values.GCE_METADATA_PROXY_SCOPES = metadataProxyScopes(box);
    values.GCE_METADATA_PROXY_BUCKET = metadataProxyBucket(box);
  }
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');
}

/** Fixed CAB resource: never supplied by the token request. */
export function metadataProxyBucket(box: Readonly<Record<string, string>>): string {
  const bucket = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])(?:\/[^?#]*)?$/.exec(
    box.CELLD_BUCKET ?? ''
  )?.[1];
  if (!bucket || bucket.includes('..'))
    throw new Error('metadata proxy requires a valid gs:// CELLD_BUCKET');
  return bucket;
}
