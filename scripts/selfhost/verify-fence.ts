#!/usr/bin/env tsx
/**
 * Checks that the celld egress fence is in effect on this box, and fails loudly if not.
 *
 *   pnpm selfhost:verify-fence [--env-file deploy/selfhost/.env] [--public-probe HOST:PORT]
 *
 * Probes run in a throwaway container of the celld service (same image, uid and host network),
 * so they get exactly what celld's sockets get. The fence rejects with ICMP admin-prohibited, so a
 * fenced connect() fails at once with "No route to host" (IPv4) or "Permission denied" (IPv6);
 * that is "blocked". Every forbidden target must be blocked, every allowed one must not be, and a
 * control run as another uid must reach the same forbidden target, which proves the probe can
 * tell a fenced socket from an unreachable one.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveTunnelPortRange } from './box-settings.js';
import {
  composePort,
  EGRESS_FENCE_TABLE,
  metadataProxyEnabled,
  metadataProxyPort,
  resolveObjectStoreEndpoints,
} from './egress-fence.js';
import { parseDotenv } from './secret-files.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const COMPOSE_FILE = join(REPO_ROOT, 'deploy/selfhost/docker-compose.yml');
const DEFAULT_PUBLIC_PROBE = '1.1.1.1:443';
/** uid for the control probe: any uid but celld's. */
const CONTROL_UID = 65534;
const DEFAULT_PROBE_TIMEOUT_SECONDS = 3;

export type ProbeOutcome = 'blocked' | 'open' | 'refused' | 'timeout' | 'unavailable' | 'error';

export interface ProbeTarget {
  label: string;
  host: string;
  port: number;
  expect: 'blocked' | 'reachable';
}

/**
 * A bash script that prints `<index> <outcome>` per target, from bash's /dev/tcp error text.
 * "unavailable" is the host lacking the address family (IPv6 off), not a verdict on the fence.
 */
export function buildProbeScript(targets: ProbeTarget[], timeoutSeconds: number): string {
  const lines = targets.map((target, index) => `probe ${index} '${target.host}' ${target.port}`);
  return [
    'probe() {',
    `  out="$(timeout ${timeoutSeconds} bash -c "exec 3<>/dev/tcp/$2/$3" 2>&1)"; code=$?`,
    '  if [ $code -eq 0 ]; then echo "$1 open"',
    '  elif [[ "$out" == *"No route to host"* || "$out" == *"Permission denied"* ]]; then echo "$1 blocked"',
    '  elif [[ "$out" == *"Connection refused"* ]]; then echo "$1 refused"',
    '  elif [[ "$out" == *"Cannot assign requested address"* || "$out" == *"Network is unreachable"* || "$out" == *"Address family not supported"* ]]; then echo "$1 unavailable"',
    '  elif [ $code -eq 124 ]; then echo "$1 timeout"',
    '  else echo "$1 error"; fi',
    '}',
    ...lines,
  ].join('\n');
}

export function parseProbeOutput(output: string): Map<number, ProbeOutcome> {
  const results = new Map<number, ProbeOutcome>();
  for (const line of output.split('\n')) {
    const match = /^(\d+) (blocked|open|refused|timeout|unavailable|error)$/.exec(line.trim());
    if (match) results.set(Number(match[1]), match[2] as ProbeOutcome);
  }
  return results;
}

export interface ProbeVerdict {
  failures: string[];
  warnings: string[];
}

function isLoopbackHost(host: string): boolean {
  return host === '::1' || host.startsWith('127.');
}

/**
 * A forbidden target is fenced when celld's uid is refused and another uid is not: "No route
 * to host" can also be the network's own answer for a remote address, never for loopback.
 */
function judgeForbidden(
  target: ProbeTarget,
  outcome: ProbeOutcome,
  control: ProbeOutcome | undefined
): { failure?: string; warning?: string } {
  const name = `${target.label} (${target.host}:${target.port})`;
  if (outcome === 'unavailable' && control === 'unavailable') {
    return { warning: `${name}: address family unavailable on this host; not applicable` };
  }
  if (outcome !== 'blocked') return { failure: `${name} is NOT fenced: ${outcome}` };
  if (control !== 'blocked') return {};
  if (isLoopbackHost(target.host)) {
    return { failure: `${name}: refused for every uid, so the probe cannot see the fence` };
  }
  return { warning: `${name}: the network refuses it for every uid too; inconclusive` };
}

/** Failures and warnings, one line each. `control` is the same probe run as another uid. */
export function evaluateProbes(
  targets: ProbeTarget[],
  results: Map<number, ProbeOutcome>,
  control: Map<number, ProbeOutcome> = new Map()
): ProbeVerdict {
  const verdict: ProbeVerdict = { failures: [], warnings: [] };
  targets.forEach((target, index) => {
    const outcome = results.get(index);
    if (outcome === undefined) {
      verdict.failures.push(`${target.label}: no result`);
      return;
    }
    if (target.expect === 'reachable') {
      if (!['open', 'refused'].includes(outcome)) {
        verdict.failures.push(
          `${target.label} (${target.host}:${target.port}) should be reachable: ${outcome}`
        );
      }
      return;
    }
    const { failure, warning } = judgeForbidden(target, outcome, control.get(index));
    if (failure) verdict.failures.push(failure);
    if (warning) verdict.warnings.push(warning);
  });
  return verdict;
}

/** What the fence must block and allow on this box. */
export async function fenceTargets(
  box: Readonly<Record<string, string>>,
  publicProbe: string
): Promise<ProbeTarget[]> {
  const range = resolveTunnelPortRange(box);
  const loopback = (label: string, port: number, expect: ProbeTarget['expect']): ProbeTarget => ({
    label,
    host: '127.0.0.1',
    port,
    expect,
  });
  const [publicHost = '', publicPort = '443'] = publicProbe.split(/:(?=\d+$)/);
  const targets: ProbeTarget[] = [
    loopback('celld operator listener', composePort(box, 'CELLD_INTERNAL_PORT'), 'blocked'),
    loopback('celld public listener', composePort(box, 'CELLD_PORT'), 'blocked'),
    loopback('frps control port', composePort(box, 'FRPS_BIND_PORT'), 'blocked'),
    loopback('object store console', composePort(box, 'OBJECTSTORE_CONSOLE_PORT'), 'blocked'),
    loopback('Caddy admin API', 2019, 'blocked'),
    {
      label: 'IPv6 loopback',
      host: '::1',
      port: composePort(box, 'CELLD_INTERNAL_PORT'),
      expect: 'blocked',
    },
    { label: 'cloud metadata server', host: '169.254.169.254', port: 80, expect: 'blocked' },
    { label: 'private 10/8', host: '10.255.255.1', port: 80, expect: 'blocked' },
    {
      label: 'private 172.16/12 (Docker bridges)',
      host: '172.17.0.1',
      port: 80,
      expect: 'blocked',
    },
    { label: 'private 192.168/16', host: '192.168.255.1', port: 80, expect: 'blocked' },
    { label: 'carrier-grade NAT', host: '100.100.100.200', port: 80, expect: 'blocked' },
    loopback('node tunnel lease port', range.start, 'reachable'),
    { label: 'public internet', host: publicHost, port: Number(publicPort), expect: 'reachable' },
  ];
  for (const endpoint of await resolveObjectStoreEndpoints(box)) {
    targets.push({
      label: 'object store',
      host: endpoint.address,
      port: endpoint.port,
      expect: 'reachable',
    });
  }
  if (metadataProxyEnabled(box)) {
    targets.push(loopback('metadata token proxy', metadataProxyPort(box), 'reachable'));
  }
  return targets;
}

function compose(envFile: string, args: string[]): { status: number; output: string } {
  const result = spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '--env-file', envFile, ...args],
    { encoding: 'utf8', cwd: dirname(COMPOSE_FILE) }
  );
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function runProbes(
  envFile: string,
  targets: ProbeTarget[],
  user: string | null
): Map<number, ProbeOutcome> {
  const script = buildProbeScript(targets, DEFAULT_PROBE_TIMEOUT_SECONDS);
  const userArgs = user ? ['--user', user] : [];
  const result = compose(envFile, [
    'run',
    '--rm',
    '--no-deps',
    '-T',
    ...userArgs,
    '--entrypoint',
    'bash',
    'celld',
    '-c',
    script,
  ]);
  return parseProbeOutput(result.output);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'env-file': { type: 'string' }, 'public-probe': { type: 'string' } },
  });
  const envFile = resolve(values['env-file'] ?? join(REPO_ROOT, 'deploy/selfhost/.env'));
  const box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
  const failures: string[] = [];

  const table = compose(envFile, [
    'exec',
    '-T',
    'egress-fence',
    'nft',
    'list',
    'table',
    'inet',
    EGRESS_FENCE_TABLE,
  ]);
  if (table.status !== 0) {
    failures.push(`nftables table ${EGRESS_FENCE_TABLE} not visible (is egress-fence running?)`);
  }

  const targets = await fenceTargets(box, values['public-probe'] ?? DEFAULT_PUBLIC_PROBE);
  // The same probes as another uid: a target only counts as fenced if that uid gets through.
  const verdict = evaluateProbes(
    targets,
    runProbes(envFile, targets, null),
    runProbes(envFile, targets, `${CONTROL_UID}:${CONTROL_UID}`)
  );
  failures.push(...verdict.failures);
  for (const warning of verdict.warnings) console.warn(`[selfhost] warning: ${warning}`);

  for (const target of targets) {
    console.log(
      `  ${target.expect === 'blocked' ? 'deny ' : 'allow'}  ${target.label} ${target.host}:${target.port}`
    );
  }
  if (failures.length > 0) {
    console.error('\n[selfhost] EGRESS FENCE NOT IN EFFECT:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('[selfhost] egress fence in effect');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
