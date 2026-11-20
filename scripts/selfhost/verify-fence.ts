#!/usr/bin/env tsx
/**
 * Checks that the celld egress fence is in effect on this box, and fails loudly if not.
 *
 *   pnpm selfhost:verify-fence [--env-file deploy/selfhost/.env] [--public-probe HOST:PORT]
 *                              [--public-name NAME]
 *
 * Probes run in a throwaway container of the celld service (same image, uid and host network),
 * so they get exactly what celld's sockets get; a control repeats them as another uid. What is
 * checked and how it is judged: fence-verify.ts. Also checked: name resolution as celld, that
 * the fence's DNS sets open every nameserver celld's resolv.conf names (resolver drift), and
 * that the fence service's attestation, which celld requires, is current.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { composeFilesFor } from './compose-env.js';

function composeArgs(input: { composeFiles: string[]; envFile: string }, args: string[]): string[] {
  return [
    'compose',
    '--env-file',
    input.envFile,
    ...input.composeFiles.flatMap((file) => ['-f', file]),
    ...args,
  ];
}
import { loadBoxEnv, resolveTunnelPortRange } from './box-settings.js';
import { EGRESS_FENCE_TABLE, parseNameservers } from './egress-fence.js';
import { buildProbeScript, parseProbeOutput, type ProbeOutcome } from './fence-probes.js';
import {
  boxAttestationProblem,
  dnsChainAddresses,
  judgeTargets,
  missingNameservers,
  probeSpecs,
  type VerifyTarget,
  verifyTargets,
} from './fence-verify.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SELFHOST_DIR = join(REPO_ROOT, 'deploy/selfhost');
const DEFAULT_PUBLIC_PROBE = '1.1.1.1:443';
const DEFAULT_PUBLIC_NAME = 'example.com';
/** uid for the control probe: any uid but celld's. */
const CONTROL_UID = 65534;
/** Above the ~1 s a refused TCP connect() takes (it is reported on the first SYN retransmit). */
const DEFAULT_PROBE_TIMEOUT_SECONDS = 4;
const ATTESTATION_PATH = '/run/sam-egress-fence/attestation';

interface Run {
  status: number;
  output: string;
}

function run(command: string, args: string[]): Run {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: SELFHOST_DIR });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Compose with every file the box runs with (its COMPOSE_FILE), as the stack was started. */
function compose(envFile: string, args: string[]): Run {
  const box = loadBoxEnv(envFile, SELFHOST_DIR);
  return run(
    'docker',
    composeArgs({ composeFiles: composeFilesFor(box, SELFHOST_DIR), envFile }, args)
  );
}

/** A sleeping container of the celld service to run probes in; removed by the caller. */
function startProbeContainer(envFile: string): string {
  const name = `sam-verify-fence-${process.pid}`;
  const started = compose(envFile, [
    'run',
    '-d',
    '--rm',
    '--no-deps',
    '--name',
    name,
    '--entrypoint',
    'sleep',
    'celld',
    '600',
  ]);
  if (started.status !== 0) throw new Error(`cannot start a probe container: ${started.output}`);
  return name;
}

function inContainer(name: string, args: string[], user?: number): Run {
  const userArgs = user === undefined ? [] : ['--user', `${user}:${user}`];
  return run('docker', ['exec', ...userArgs, name, ...args]);
}

function probe(
  name: string,
  targets: readonly VerifyTarget[],
  user?: number
): Map<number, ProbeOutcome> {
  const specs = probeSpecs(targets);
  const script = buildProbeScript(specs, DEFAULT_PROBE_TIMEOUT_SECONDS);
  const run = inContainer(name, ['bash', '-c', script], user);
  if (run.status !== 0) throw new Error('fence probe execution failed');
  const results = parseProbeOutput(run.output);
  if (results.size !== specs.length || specs.some((_, index) => !results.has(index))) {
    throw new Error('fence probe results are incomplete');
  }
  return results;
}

/** The nameservers chain `dns` of the applied fence opens, from the fence service; null if unreadable. */
function appliedNameservers(envFile: string): string[] | null {
  const listed = compose(envFile, [
    'exec',
    '-T',
    'egress-fence',
    'nft',
    'list',
    'chain',
    'inet',
    EGRESS_FENCE_TABLE,
    'dns',
  ]);
  return listed.status === 0 ? dnsChainAddresses(listed.output) : null;
}

/** celld's resolv.conf: the running celld container's, else the probe container's. */
function celldNameservers(envFile: string, probeContainer: string): string[] {
  const running = compose(envFile, ['exec', '-T', 'celld', 'cat', '/etc/resolv.conf']);
  let text = running.output;
  if (running.status !== 0) {
    const state = compose(envFile, ['ps', '--status', 'running', '--quiet', 'celld']);
    if (state.status !== 0 || state.output.trim()) {
      throw new Error('cannot read resolver configuration from running celld');
    }
    const fallback = inContainer(probeContainer, ['cat', '/etc/resolv.conf']);
    if (fallback.status !== 0) throw new Error('cannot read probe resolver configuration');
    text = fallback.output;
  }
  const servers = parseNameservers(text);
  if (servers.length === 0) throw new Error('resolver configuration contains no nameservers');
  return servers;
}

function checkService(envFile: string, probeContainer: string, failures: string[]): void {
  const checked = compose(envFile, [
    'exec',
    '-T',
    'egress-fence',
    '/bin/sh',
    '/usr/local/bin/sam-egress-fence',
    'check',
  ]);
  if (checked.status !== 0) {
    failures.push('the fence service check failed: rules changed or fence loss is latched');
    return;
  }
  const applied = appliedNameservers(envFile);
  if (applied === null) {
    failures.push(
      'cannot read the fence from the egress-fence service: it is not running, and celld ' +
        'stops serving once its attestation is stale'
    );
    return;
  }
  const missing = missingNameservers(celldNameservers(envFile, probeContainer), applied);
  if (missing.length > 0) {
    failures.push(
      `resolver drift: celld uses ${missing.join(', ')}, which the fence's DNS sets do not ` +
        'open; run pnpm selfhost:deploy --init to regenerate and reconcile the fence, then rerun verification'
    );
  }
  const attestation = compose(envFile, ['exec', '-T', 'egress-fence', 'cat', ATTESTATION_PATH]);
  const problem = boxAttestationProblem(
    attestation.output,
    Math.floor(Date.now() / 1000),
    loadBoxEnv(envFile, SELFHOST_DIR)
  );
  if (problem) failures.push(`${problem}; celld stops serving without it`);
}

function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .map((entry) => entry?.address ?? '')
    .filter(Boolean);
}

async function verify(envFile: string, publicProbe: string, publicName: string): Promise<string[]> {
  const box = loadBoxEnv(envFile, SELFHOST_DIR);
  const own = localAddresses();
  const targets = await verifyTargets({
    box,
    range: resolveTunnelPortRange(box),
    publicProbe,
    localAddresses: own,
    resolvConf: readFileSync('/etc/resolv.conf', 'utf8'),
  });
  const name = startProbeContainer(envFile);
  try {
    const verdict = judgeTargets(
      targets,
      probe(name, targets),
      probe(name, targets, CONTROL_UID),
      new Set(own)
    );
    for (const note of verdict.notes) console.warn(`[selfhost] note: ${note}`);
    const failures = [...verdict.failures];
    if (inContainer(name, ['getent', 'ahosts', publicName]).status !== 0) {
      failures.push(`celld cannot resolve ${publicName}: DNS is blocked or the resolver is down`);
    }
    checkService(envFile, name, failures);
    for (const target of targets) {
      console.log(
        `  ${target.expect === 'blocked' ? 'deny ' : 'allow'}  ${target.label} ${target.host}:${target.port}`
      );
    }
    return failures;
  } finally {
    run('docker', ['rm', '-f', name]);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'public-probe': { type: 'string' },
      'public-name': { type: 'string' },
    },
  });
  const envFile = resolve(values['env-file'] ?? join(REPO_ROOT, 'deploy/selfhost/.env'));
  const failures = await verify(
    envFile,
    values['public-probe'] ?? DEFAULT_PUBLIC_PROBE,
    values['public-name'] ?? DEFAULT_PUBLIC_NAME
  );
  if (failures.length > 0) {
    console.error('\n[selfhost] EGRESS FENCE NOT IN EFFECT:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('[selfhost] egress fence in effect');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
