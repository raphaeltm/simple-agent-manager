/**
 * Host classification for every outbound request whose URL someone other than the code author
 * chose: a user's credential base URL, a web push endpoint, a registry, an admin's LLM endpoint.
 *
 * On Cloudflare a Worker cannot reach private addresses. On a self-hosted runtime (celld on one
 * box) it shares the host network, so loopback services, private ranges and the cloud metadata
 * server are all one `fetch` away. Every host therefore falls in one of three classes:
 *
 * - `forbidden`: never a valid endpoint, for anyone: link-local (169.254/16, fe80::/10, which hold
 *   the metadata servers), named metadata hosts, unspecified, multicast, reserved and
 *   documentation ranges.
 * - `private`: loopback, RFC 1918, carrier-grade NAT, unique-local IPv6, `localhost`, single-label
 *   and `.local`/`.internal`-style names. Only an operator may opt in to these.
 * - `public`: everything else.
 *
 * Literal addresses are recognised in every spelling a URL parser or `inet_aton` accepts:
 * dotted, decimal, hex and octal IPv4, short forms (`127.1`), trailing dots, and IPv6 including
 * IPv4-mapped, -compatible, -translated, NAT64 and 6to4 embeddings.
 *
 * A name check cannot see what a name resolves to: a public name whose DNS answer is
 * 127.0.0.1 passes as `public`. The host-level egress fence on a self-hosted box
 * (deploy/selfhost/egress-fence) is what stops that case.
 */

export type HostClass = 'public' | 'private' | 'forbidden';

/** Hostnames of instance metadata services on the major clouds. */
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

/** Name suffixes that only resolve on a private network. */
const PRIVATE_NAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.lan',
  '.home.arpa',
];

const IPV4_MAX = 0xffff_ffff;

function ipv4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** `[start, prefixLength, class]` for IPv4 ranges that are not public; first match wins. */
const IPV4_RANGES: ReadonlyArray<readonly [number, number, Exclude<HostClass, 'public'>]> = [
  [ipv4(100, 100, 100, 200), 32, 'forbidden'], // Alibaba Cloud metadata, inside CGNAT
  [ipv4(168, 63, 129, 16), 32, 'forbidden'], // Azure WireServer (host agent), a public address
  [ipv4(0, 0, 0, 0), 8, 'forbidden'], // "this network"; 0.0.0.0 reaches local listeners
  [ipv4(169, 254, 0, 0), 16, 'forbidden'], // link-local, cloud metadata
  [ipv4(192, 0, 0, 0), 24, 'forbidden'], // IETF protocol assignments
  [ipv4(192, 0, 2, 0), 24, 'forbidden'], // documentation
  [ipv4(198, 51, 100, 0), 24, 'forbidden'], // documentation
  [ipv4(203, 0, 113, 0), 24, 'forbidden'], // documentation
  [ipv4(192, 88, 99, 0), 24, 'forbidden'], // 6to4 relay anycast
  [ipv4(224, 0, 0, 0), 3, 'forbidden'], // multicast, reserved, broadcast
  [ipv4(127, 0, 0, 0), 8, 'private'], // loopback
  [ipv4(10, 0, 0, 0), 8, 'private'],
  [ipv4(172, 16, 0, 0), 12, 'private'],
  [ipv4(192, 168, 0, 0), 16, 'private'],
  [ipv4(100, 64, 0, 0), 10, 'private'], // carrier-grade NAT
  [ipv4(198, 18, 0, 0), 15, 'private'], // benchmarking
];

export function classifyIpv4(address: number): HostClass {
  for (const [start, prefix, hostClass] of IPV4_RANGES) {
    const mask = prefix === 0 ? 0 : (IPV4_MAX << (32 - prefix)) >>> 0;
    if ((address & mask) >>> 0 === start) return hostClass;
  }
  return 'public';
}

/** One `inet_aton` component: decimal, `0x` hex or leading-zero octal. */
function parseIpv4Component(part: string): number | null {
  let digits = part;
  let radix = 10;
  if (/^0x/i.test(part)) {
    digits = part.slice(2);
    radix = 16;
  } else if (part.length > 1 && part.startsWith('0')) {
    digits = part.slice(1);
    radix = 8;
  }
  if (digits === '') return radix === 16 ? 0 : null;
  const pattern = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(digits) || digits.length > 32) return null;
  const value = Number.parseInt(digits, radix);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * An IPv4 literal in any `inet_aton` / WHATWG spelling (`127.0.0.1`, `2130706433`,
 * `0x7f.1`, `0177.0.0.1`, `127.1`), as a 32-bit number. Null for anything else.
 */
export function parseIpv4Literal(host: string): number | null {
  const parts = host.split('.');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;
  const values = parts.map(parseIpv4Component);
  if (values.some((value) => value === null)) return null;
  const numbers = values as number[];
  const last = numbers[numbers.length - 1] ?? 0;
  const leading = numbers.slice(0, -1);
  if (leading.some((value) => value > 255)) return null;
  if (last >= 256 ** (5 - numbers.length)) return null;
  let address = last;
  leading.forEach((value, index) => {
    address += value * 256 ** (3 - index);
  });
  return address;
}

function parseIpv6Groups(part: string): number[] | null {
  if (!part) return [];
  const groups: number[] = [];
  for (const piece of part.split(':')) {
    if (piece.includes('.')) {
      const embedded = /^\d{1,3}(\.\d{1,3}){3}$/.test(piece) ? parseIpv4Literal(piece) : null;
      if (embedded === null) return null;
      groups.push(embedded >>> 16, embedded & 0xffff);
    } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
      groups.push(Number.parseInt(piece, 16));
    } else {
      return null;
    }
  }
  return groups;
}

/** An IPv6 literal (no brackets, no zone) as eight 16-bit groups. Null for anything else. */
export function parseIpv6Literal(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = parseIpv6Groups(halves[0] ?? '');
  const tail = parseIpv6Groups(halves[1] ?? '');
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function embeddedIpv4(high: number | undefined, low: number | undefined): number {
  return (((high ?? 0) << 16) >>> 0) + (low ?? 0);
}

function startsWithZeros(groups: number[], count: number): boolean {
  return groups.slice(0, count).every((group) => group === 0);
}

function ipv6(text: string): bigint {
  const groups = parseIpv6Literal(text);
  if (!groups) throw new Error(`invalid IPv6 range ${text}`);
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

type Ipv6Range = readonly [start: bigint, prefix: number, hostClass: Exclude<HostClass, 'public'>];

/** Checked before embedded IPv4: these are themselves inside the IPv4-compatible block. */
const IPV6_EXACT: readonly Ipv6Range[] = [
  [ipv6('::'), 128, 'forbidden'], // unspecified
  [ipv6('::1'), 128, 'private'], // loopback
  [ipv6('fd00:ec2::254'), 128, 'forbidden'], // AWS IMDS over IPv6
  [ipv6('fd20:ce::254'), 128, 'forbidden'], // GCE metadata over IPv6
];

const IPV6_RANGES: readonly Ipv6Range[] = [
  [ipv6('fe80::'), 10, 'forbidden'], // link-local
  [ipv6('ff00::'), 8, 'forbidden'], // multicast
  [ipv6('2001::'), 32, 'forbidden'], // Teredo
  [ipv6('2001:db8::'), 32, 'forbidden'], // documentation
  [ipv6('100::'), 64, 'forbidden'], // discard
  [ipv6('64:ff9b:1::'), 48, 'private'], // local-use NAT64
  [ipv6('fec0::'), 10, 'private'], // deprecated site-local
  [ipv6('fc00::'), 7, 'private'], // unique-local
];

function matchIpv6(value: bigint, ranges: readonly Ipv6Range[]): HostClass | null {
  for (const [start, prefix, hostClass] of ranges) {
    const shift = BigInt(128 - prefix);
    if (value >> shift === start >> shift) return hostClass;
  }
  return null;
}

/** The IPv4 address an IPv6 literal routes to, for the forms that embed one. */
function embeddedIpv4Of(groups: number[]): number | null {
  const [g0 = 0, g1 = 0, g2 = 0, , g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const mapped = startsWithZeros(groups, 5) && g5 === 0xffff; // ::ffff:a.b.c.d
  const translated = startsWithZeros(groups, 4) && g4 === 0xffff && g5 === 0; // ::ffff:0:a.b.c.d
  const compatible = startsWithZeros(groups, 6); // ::a.b.c.d
  const nat64 = g0 === 0x64 && g1 === 0xff9b && startsWithZeros(groups.slice(2), 4);
  if (mapped || translated || compatible || nat64) return embeddedIpv4(g6, g7);
  return g0 === 0x2002 ? embeddedIpv4(g1, g2) : null; // 6to4
}

export function classifyIpv6(groups: number[]): HostClass {
  const value = groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
  const exact = matchIpv6(value, IPV6_EXACT);
  if (exact) return exact;
  const embedded = embeddedIpv4Of(groups);
  if (embedded !== null) return classifyIpv4(embedded);
  return matchIpv6(value, IPV6_RANGES) ?? 'public';
}

function classifyName(host: string): HostClass {
  if (METADATA_HOSTNAMES.has(host) || host.endsWith('.metadata.google.internal'))
    return 'forbidden';
  if (host === 'localhost' || !host.includes('.')) return 'private';
  return PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix)) ? 'private' : 'public';
}

/** A URL `hostname` (or a bare host) classified as public, private or forbidden. */
export function classifyHost(hostname: string): HostClass {
  const host = hostname
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '');
  // Empty hosts, zone ids and percent-encoded hosts are never a valid outbound endpoint.
  if (!host || host.includes('%') || /[\s/\\@]/.test(host)) return 'forbidden';
  if (host.includes(':')) {
    const groups = parseIpv6Literal(host);
    return groups ? classifyIpv6(groups) : 'forbidden';
  }
  const address = parseIpv4Literal(host);
  if (address !== null) return classifyIpv4(address);
  // A host whose last label is numeric is an IPv4 literal to a URL parser; one that did not
  // parse above is invalid, never a name.
  if (/^(\d+|0x[0-9a-f]*)$/i.test(host.split('.').pop() ?? '')) return 'forbidden';
  return classifyName(host);
}

/** Link-local, metadata, unspecified, multicast and reserved hosts. */
export function isForbiddenEndpointHost(hostname: string): boolean {
  return classifyHost(hostname) === 'forbidden';
}

/** Loopback, private ranges and private-network names. */
export function isPrivateNetworkHost(hostname: string): boolean {
  return classifyHost(hostname) === 'private';
}

/**
 * An operator endpoint URL (LLM endpoint, S3 store): HTTPS to any host except a forbidden one,
 * or HTTP to a private host. Never userinfo, query or fragment. Whether a private host may be
 * reached at use time is a separate operator opt-in (`OutboundPolicy.allowPrivateNetwork`).
 */
export function isAcceptableOperatorEndpoint(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return false;
  const hostClass = classifyHost(url.hostname);
  if (url.protocol === 'https:') return hostClass !== 'forbidden';
  return url.protocol === 'http:' && hostClass === 'private';
}
