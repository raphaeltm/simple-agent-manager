/**
 * Address policy shared by the egress-fence renderer, the deploy and the verify command.
 *
 * `isNeverAllowed` is the one check every operator-supplied endpoint goes through before the
 * fence opens it (S3_ENDPOINT, whatever it resolves to, and every SAM_EGRESS_ALLOW entry): no
 * configuration may open a cloud metadata server, a link-local address or a reserved range.
 * Private and loopback addresses stay openable, since a bundled store or a local model server
 * lives there; the fence opens those only at their exact address and port.
 */
import { BlockList, isIP } from 'node:net';

/** IPv4 ranges no endpoint may open. Node folds IPv4-mapped IPv6 (::ffff:a.b.c.d) onto these. */
const NEVER_ALLOWED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['169.254.0.0', 16], // link-local: every cloud metadata server (AWS, GCE, Azure, ...)
  ['100.100.100.200', 32], // Alibaba Cloud metadata
  ['168.63.129.16', 32], // Azure WireServer
  ['192.0.0.0', 24], // IETF protocol assignments (incl. 192.0.0.192 Oracle Cloud metadata)
  ['224.0.0.0', 3], // multicast, reserved, broadcast
];

const NEVER_ALLOWED_IPV6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // unspecified
  ['fe80::', 10], // link-local
  ['fd00:ec2::254', 128], // AWS IMDS over IPv6
  ['fd20:ce::254', 128], // GCE metadata over IPv6
  ['ff00::', 8], // multicast
];

const neverAllowed = new BlockList();
for (const [address, prefix] of NEVER_ALLOWED_IPV4) neverAllowed.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of NEVER_ALLOWED_IPV6) neverAllowed.addSubnet(address, prefix, 'ipv6');

/** The eight 16-bit groups of an IPv6 literal (no zone id), or null. */
export function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros =
    tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address a NAT64 (64:ff9b::/96) or 6to4 (2002::/16) literal reaches, or null. */
function translatedIpv4(groups: number[]): string | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const word = (hi: number, lo: number): string =>
    [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return word(g6, g7);
  }
  return g0 === 0x2002 ? word(g1, g2) : null;
}

/**
 * Whether no configuration may open `address`: metadata, link-local and reserved addresses in
 * every spelling (IPv4-mapped, NAT64 and 6to4 forms of them included).
 */
export function isNeverAllowed(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return neverAllowed.check(address, 'ipv4');
  if (family !== 6) return true; // not an IP literal: the fence matches addresses only
  if (neverAllowed.check(address, 'ipv6')) return true;
  const groups = ipv6Groups(address);
  const embedded = groups ? translatedIpv4(groups) : null;
  return embedded !== null && neverAllowed.check(embedded, 'ipv4');
}

/** Refuses `address` with a message that names where it came from. */
export function assertOpenable(address: string, source: string): void {
  if (isNeverAllowed(address)) {
    throw new Error(
      `${source}: ${address} is a metadata, link-local or reserved address; the egress fence ` +
        'never opens it'
    );
  }
}
