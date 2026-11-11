/**
 * Probe targets that show each class of the egress fence's rules is in effect, one per class
 * and address family. celld's entrypoint (deploy/selfhost/celld/start.sh) runs these before it
 * starts celld and on every periodic check; `pnpm selfhost:verify-fence` runs them and more.
 *
 * The start check sends a UDP datagram per target: a send the fence refuses fails at once with
 * "Operation not permitted" (EPERM, which only the local firewall produces), and succeeds
 * without the rule. The reject rules match addresses for every protocol, so one datagram shows
 * the class is in place. (A refused TCP connect() fails with "No route to host" or "Permission
 * denied", but only on the first SYN retransmit, about a second later.)
 */
import { isIP } from 'node:net';

import type { EgressFencePlan } from './egress-fence.js';

export interface FenceProbe {
  /** Rule class the probe exercises; stable, used in messages and tests. */
  name: string;
  host: string;
  port: number;
}

/** Addresses outside this box for the remote rule classes (nothing needs to listen there). */
export const REMOTE_PROBES: readonly FenceProbe[] = [
  { name: 'private-v4', host: '10.255.255.1', port: 80 },
  { name: 'metadata-v4', host: '169.254.169.254', port: 80 },
  { name: 'cgnat-v4', host: '100.100.100.200', port: 80 },
  { name: 'unique-local-v6', host: 'fd00::1', port: 80 },
  { name: 'metadata-v6', host: 'fd20:ce::254', port: 80 },
  { name: '6to4-v6', host: '2002:a9fe:a9fe::1', port: 80 },
  { name: 'teredo-v6', host: '2001::1', port: 80 },
];

/** This host's first usable IPv4 and IPv6 interface address, if any. */
export function hostAddresses(localAddresses: readonly string[]): string[] {
  const usable = localAddresses.filter(
    (address) =>
      address !== '::1' &&
      !address.startsWith('127.') &&
      !address.toLowerCase().startsWith('fe80') &&
      isIP(address) !== 0
  );
  const v4 = usable.find((address) => isIP(address) === 4);
  const v6 = usable.find((address) => isIP(address) === 6);
  return [v4, v6].filter((address): address is string => address !== undefined);
}

/**
 * The start check's probes: celld's own operator port on every local spelling (loopback, another
 * loopback address, IPv6 loopback, the host's own addresses), then one remote target per range.
 */
export function startCheckProbes(plan: EgressFencePlan): FenceProbe[] {
  const operator = plan.forbiddenLoopbackPorts.CELLD_INTERNAL_PORT ?? 7001;
  const local: FenceProbe[] = [
    { name: 'loopback-v4', host: '127.0.0.1', port: operator },
    { name: 'loopback-other-v4', host: '127.0.0.2', port: operator },
    { name: 'loopback-v6', host: '::1', port: operator },
    ...hostAddresses(plan.localAddresses).map((host) => ({
      name: isIP(host) === 6 ? 'host-address-v6' : 'host-address-v4',
      host,
      port: operator,
    })),
  ];
  return [...local, ...REMOTE_PROBES];
}

/** `name,host,port` entries separated by spaces (IPv6 hosts contain colons, never commas). */
export function formatProbes(probes: readonly FenceProbe[]): string {
  return probes.map((probe) => `${probe.name},${probe.host},${probe.port}`).join(' ');
}

export type ProbeOutcome =
  'blocked' | 'open' | 'refused' | 'unreachable' | 'timeout' | 'unavailable' | 'error';

export interface ProbeSpec {
  host: string;
  port: number;
  /** Default tcp. A UDP probe sends two datagrams; "open" then only means nothing refused it. */
  protocol?: 'tcp' | 'udp';
}

/**
 * A bash script that prints `<index> <outcome>` per target, from bash's /dev/tcp and /dev/udp
 * error text. The fence's reject reads as "No route to host" (TCP over IPv4), "Permission
 * denied" (TCP over IPv6) or "Operation not permitted" (UDP). "unavailable" is the host lacking
 * the address family or a route, not a verdict on the fence. Probes run in parallel: a refused
 * TCP connect() is only reported on the first SYN retransmit, about a second after it starts.
 */
export function buildProbeScript(targets: readonly ProbeSpec[], timeoutSeconds: number): string {
  const lines = targets.map(
    (target, index) =>
      `probe ${index} ${target.protocol ?? 'tcp'} '${target.host}' ${target.port} &`
  );
  return [
    'probe() {',
    '  if [ "$2" = udp ]; then',
    `    out="$(timeout ${timeoutSeconds} bash -c 'exec 3<>"/dev/udp/$0/$1" && printf x >&3 && sleep 0.2 && printf x >&3' "$3" "$4" 2>&1)"; code=$?`,
    // For UDP only EPERM is the fence: "No route to host" can be a router's ICMP answer.
    '    blocked="Operation not permitted"; unreachable="No route to host"',
    '  else',
    `    out="$(timeout ${timeoutSeconds} bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$3" "$4" 2>&1)"; code=$?`,
    '    blocked="No route to host"; unreachable="@none@"',
    '  fi',
    '  if [ $code -eq 0 ]; then echo "$1 open"',
    '  elif [[ "$out" == *"$blocked"* || ( "$2" = tcp && "$out" == *"Permission denied"* ) ]]; then echo "$1 blocked"',
    '  elif [[ "$out" == *"$unreachable"* ]]; then echo "$1 unreachable"',
    '  elif [[ "$out" == *"Connection refused"* ]]; then echo "$1 refused"',
    '  elif [[ "$out" == *"Cannot assign requested address"* || "$out" == *"Network is unreachable"* || "$out" == *"Address family not supported"* ]]; then echo "$1 unavailable"',
    '  elif [ $code -eq 124 ]; then echo "$1 timeout"',
    '  else echo "$1 error"; fi',
    '}',
    ...lines,
    'wait',
  ].join('\n');
}

export function parseProbeOutput(output: string): Map<number, ProbeOutcome> {
  const results = new Map<number, ProbeOutcome>();
  for (const line of output.split('\n')) {
    const match = /^(\d+) (blocked|open|refused|unreachable|timeout|unavailable|error)$/.exec(
      line.trim()
    );
    if (match) results.set(Number(match[1]), match[2] as ProbeOutcome);
  }
  return results;
}
