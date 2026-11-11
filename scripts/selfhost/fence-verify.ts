/**
 * What `pnpm selfhost:verify-fence` checks, and how it judges the results (pure; the Docker
 * plumbing is in verify-fence.ts).
 *
 * Every forbidden target is probed twice as celld's uid: over TCP (what Worker code uses) and
 * over UDP. A UDP send the fence refuses fails with EPERM ("Operation not permitted"), which
 * nothing but the local firewall produces, so it proves the fence matched that address even when
 * the network itself would refuse it for every uid. A TCP probe must be refused too. A control
 * uid repeats every probe: for a local target it must get through, which shows the listener
 * exists and the probe can tell "fenced" from "nothing there".
 */
import { isIP } from 'node:net';

import { type PortRange } from './box-settings.js';
import {
  composePort,
  metadataProxyEnabled,
  metadataProxyPort,
  resolveObjectStoreEndpoints,
} from './egress-fence.js';
import { hostAddresses, type ProbeOutcome, type ProbeSpec, REMOTE_PROBES } from './fence-probes.js';

export interface VerifyTarget {
  label: string;
  host: string;
  port: number;
  expect: 'blocked' | 'reachable';
}

export interface Verdict {
  failures: string[];
  notes: string[];
}

function isLocalHost(host: string, localAddresses: ReadonlySet<string>): boolean {
  return (
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('::ffff:127.') ||
    localAddresses.has(host)
  );
}

/** Every probe a target needs: TCP always, plus UDP for a forbidden one. */
export function probeSpecs(targets: readonly VerifyTarget[]): ProbeSpec[] {
  return targets.flatMap((target): ProbeSpec[] => {
    const tcp: ProbeSpec = { host: target.host, port: target.port, protocol: 'tcp' };
    return target.expect === 'blocked' ? [tcp, { ...tcp, protocol: 'udp' }] : [tcp];
  });
}

interface Outcomes {
  tcp?: ProbeOutcome;
  udp?: ProbeOutcome;
  controlTcp?: ProbeOutcome;
}

function judgeForbidden(target: VerifyTarget, seen: Outcomes, local: boolean): string | null {
  const name = `${target.label} (${target.host}:${target.port})`;
  if (seen.udp !== 'blocked') return `${name} is NOT fenced: UDP ${seen.udp ?? 'no result'}`;
  if (seen.tcp !== 'blocked') return `${name} is NOT fenced: TCP ${seen.tcp ?? 'no result'}`;
  if (local && seen.controlTcp === 'blocked') {
    return `${name}: refused for every uid, so the probe cannot see the fence`;
  }
  return null;
}

/** Failures (one line each) and notes, from the probe results in probeSpecs() order. */
export function judgeTargets(
  targets: readonly VerifyTarget[],
  results: ReadonlyMap<number, ProbeOutcome>,
  control: ReadonlyMap<number, ProbeOutcome>,
  localAddresses: ReadonlySet<string> = new Set()
): Verdict {
  const verdict: Verdict = { failures: [], notes: [] };
  let index = 0;
  for (const target of targets) {
    const seen: Outcomes = { tcp: results.get(index), controlTcp: control.get(index) };
    index += 1;
    if (target.expect === 'reachable') {
      if (seen.tcp !== 'open' && seen.tcp !== 'refused') {
        verdict.failures.push(
          `${target.label} (${target.host}:${target.port}) should be reachable: ${seen.tcp ?? 'no result'}`
        );
      }
      continue;
    }
    seen.udp = results.get(index);
    const controlUdp = control.get(index);
    index += 1;
    if (isIP(target.host) === 6 && seen.udp === 'unavailable' && controlUdp === 'unavailable') {
      verdict.notes.push(`${target.label}: this host has no IPv6 route there; not applicable`);
      continue;
    }
    const failure = judgeForbidden(target, seen, isLocalHost(target.host, localAddresses));
    if (failure) verdict.failures.push(failure);
  }
  return verdict;
}

export interface TargetInput {
  box: Readonly<Record<string, string>>;
  range: PortRange;
  publicProbe: string;
  /** This host's interface addresses (os.networkInterfaces()). */
  localAddresses: readonly string[];
}

function localTargets(
  box: Readonly<Record<string, string>>,
  own: readonly string[]
): VerifyTarget[] {
  const operator = composePort(box, 'CELLD_INTERNAL_PORT');
  const at = (label: string, host: string, port: number): VerifyTarget => ({
    label,
    host,
    port,
    expect: 'blocked',
  });
  return [
    at('celld operator listener', '127.0.0.1', operator),
    at('celld public listener', '127.0.0.1', composePort(box, 'CELLD_PORT')),
    at('frps control port', '127.0.0.1', composePort(box, 'FRPS_BIND_PORT')),
    at('object store console', '127.0.0.1', composePort(box, 'OBJECTSTORE_CONSOLE_PORT')),
    at('Caddy admin API', '127.0.0.1', 2019),
    at('Caddy HTTPS port on loopback', '127.0.0.1', composePort(box, 'HTTPS_PORT')),
    at('another loopback address', '127.0.0.2', operator),
    at('IPv6 loopback', '::1', operator),
    at('IPv4-mapped loopback', '::ffff:127.0.0.1', operator),
    ...own.map((host) => at("this host's own address, operator port", host, operator)),
    ...own.map((host) => at("this host's own address, Caddy admin port", host, 2019)),
  ];
}

function remoteTargets(): VerifyTarget[] {
  return [
    ...REMOTE_PROBES.map((probe) => ({
      label: probe.name,
      host: probe.host,
      port: probe.port,
      expect: 'blocked' as const,
    })),
    {
      label: 'private 172.16/12 (Docker bridges)',
      host: '172.17.0.1',
      port: 80,
      expect: 'blocked',
    },
    { label: 'private 192.168/16', host: '192.168.255.1', port: 80, expect: 'blocked' },
    { label: 'IPv4-mapped metadata', host: '::ffff:169.254.169.254', port: 80, expect: 'blocked' },
    { label: 'NAT64 metadata', host: '64:ff9b::a9fe:a9fe', port: 80, expect: 'blocked' },
  ];
}

/** What the fence must block and allow on this box. */
export async function verifyTargets(input: TargetInput): Promise<VerifyTarget[]> {
  const { box, range, publicProbe } = input;
  const own = hostAddresses(input.localAddresses);
  const [publicHost = '', publicPort = '443'] = publicProbe.split(/:(?=\d+$)/);
  const allow = (label: string, host: string, port: number): VerifyTarget => ({
    label,
    host,
    port,
    expect: 'reachable',
  });
  const targets: VerifyTarget[] = [
    ...localTargets(box, own),
    ...remoteTargets(),
    allow('node tunnel lease port', '127.0.0.1', range.start),
    allow('public internet', publicHost, Number(publicPort)),
    ...own.map((host) =>
      allow("Caddy on this host's own address", host, composePort(box, 'HTTPS_PORT'))
    ),
  ];
  for (const endpoint of await resolveObjectStoreEndpoints(box)) {
    targets.push(allow('object store', endpoint.address, endpoint.port));
  }
  if (metadataProxyEnabled(box)) {
    targets.push(allow('metadata token proxy', '127.0.0.1', metadataProxyPort(box)));
  }
  return targets;
}

/** Nameservers celld uses that the applied DNS sets do not open (resolver drift). */
export function missingNameservers(
  celldResolvConf: readonly string[],
  applied: readonly string[]
): string[] {
  const open = new Set(applied);
  return celldResolvConf.filter((server) => !open.has(server));
}

/** Why the fence service's attestation (`ok <epoch>`) is not current, or null. */
export function attestationProblem(
  text: string,
  nowSeconds: number,
  maxAgeSeconds: number
): string | null {
  const match = /^ok (\d+)\s*$/.exec(text);
  if (!match) return `the fence service has not attested (got "${text.trim().slice(0, 40)}")`;
  const age = nowSeconds - Number(match[1]);
  return age > maxAgeSeconds
    ? `the fence service's attestation is ${age}s old (limit ${maxAgeSeconds}s)`
    : null;
}
