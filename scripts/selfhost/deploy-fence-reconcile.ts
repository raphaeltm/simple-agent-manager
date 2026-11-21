/** Reconcile generated fence inputs for an existing Compose installation, including --init. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { PortRange } from './box-settings.js';
import { commandPath } from './command-path.js';
import { composeFilesFor } from './compose-env.js';
import { SELFHOST_DIR } from './deploy-steps.js';
import { metadataProxyEnabled } from './egress-fence.js';
import { writeFenceFiles } from './fence-state.js';
import { replacePrivateFile } from './secret-files.js';

/** Bounds daemon discovery, stop and recreate; --wait also checks fence health before celld. */
const DEFAULT_COMPOSE_TIMEOUT_MS = 60_000;
const COMPOSE_OUTPUT_MAX_BYTES = 64 * 1024;
const SERVICES: ReadonlySet<string> = new Set(['egress-fence', 'celld', 'gce-metadata-proxy']);

interface FenceReconcileInput {
  stateDir: string;
  envFile: string;
  box: Readonly<Record<string, string>>;
  leaseRange: PortRange;
}

interface PendingReconciliation {
  rules: boolean;
  env: boolean;
  celld: boolean;
  proxy: boolean;
}

type Compose = (args: string[]) => string;

function composeRunner({ stateDir, envFile, box }: FenceReconcileInput): Compose {
  const rawTimeout =
    process.env.SELFHOST_COMPOSE_TIMEOUT_MS ||
    box.SELFHOST_COMPOSE_TIMEOUT_MS ||
    String(DEFAULT_COMPOSE_TIMEOUT_MS);
  const timeout = Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error('SELFHOST_COMPOSE_TIMEOUT_MS must be a positive integer');
  }
  return (args: string[]) => {
    const result = spawnSync(
      commandPath('docker'),
      [
        'compose',
        ...composeFilesFor(box, SELFHOST_DIR).flatMap((file) => ['-f', file]),
        '--env-file',
        envFile,
        ...args,
      ],
      {
        cwd: SELFHOST_DIR,
        env: { ...process.env, ...box, SAM_SELFHOST_STATE_DIR: stateDir },
        encoding: 'utf8',
        timeout,
        maxBuffer: COMPOSE_OUTPUT_MAX_BYTES,
      }
    );
    // Compose output can contain interpolated credentials. Never log or propagate it.
    if (result.error || result.status !== 0)
      throw new Error('fence reconciliation failed: Compose command failed');
    return result.stdout;
  };
}

function serviceStates(existing: boolean, compose: Compose): Map<string, string> {
  const states = new Map<string, string>();
  if (!existing) return states;
  const output = compose(['ps', '--all', '--format', 'json']).trim();
  try {
    // Compose versions emit either a JSON array or one object per line.
    const rows: unknown = output.startsWith('[')
      ? JSON.parse(output)
      : output
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
    if (!Array.isArray(rows)) throw new Error('invalid services');
    for (const row of rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        typeof row.Service !== 'string' ||
        typeof row.State !== 'string'
      )
        throw new Error('invalid service');
      if (SERVICES.has(row.Service)) states.set(row.Service, row.State);
    }
  } catch {
    throw new Error('fence reconciliation failed: invalid Compose service state');
  }
  return states;
}

function pendingReconciliation(marker: string): PendingReconciliation {
  let pending = { rules: false, env: false, celld: false, proxy: false };
  if (existsSync(marker)) {
    const stored: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !('rules' in stored) ||
      !('env' in stored) ||
      typeof stored.rules !== 'boolean' ||
      typeof stored.env !== 'boolean' ||
      !('celld' in stored) ||
      typeof stored.celld !== 'boolean' ||
      !('proxy' in stored) ||
      typeof stored.proxy !== 'boolean'
    )
      throw new Error('invalid pending fence reconciliation');
    pending = { rules: stored.rules, env: stored.env, celld: stored.celld, proxy: stored.proxy };
  }
  return pending;
}

function reconcileServices(
  compose: Compose,
  pending: PendingReconciliation,
  states: ReadonlyMap<string, string>,
  box: FenceReconcileInput['box']
): void {
  const recreate = (service: string) =>
    compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', service]);
  if (pending.celld) compose(['stop', 'celld']);
  if (pending.rules) {
    // Missing fence is an invalid existing stack; do not create new services implicitly.
    if (!states.has('egress-fence')) throw new Error('missing fence service');
    recreate('egress-fence');
  }
  if ((pending.env || pending.rules) && pending.proxy) {
    if (metadataProxyEnabled(box)) recreate('gce-metadata-proxy');
    else compose(['stop', 'gce-metadata-proxy']);
  }
  if (pending.celld) {
    if (pending.rules) compose(['run', '--rm', '--no-deps', 'celld-data-owner']);
    recreate('celld');
  }
}

function stopCredentialConsumers(compose: Compose, states: ReadonlyMap<string, string>): void {
  const consumers = ['celld', 'gce-metadata-proxy'].filter((name) => states.has(name));
  if (consumers.length === 0) return;
  try {
    compose(['stop', ...consumers]);
  } catch {
    /* Report failure without printing credentials. */
  }
}

/** Merge original consumer intent before a changed bind mount can reach a running service. */
function checkpointReconciliation(
  pending: PendingReconciliation,
  changed: readonly string[],
  input: FenceReconcileInput,
  states: ReadonlyMap<string, string>,
  marker: string,
  existing: boolean
): void {
  pending.rules ||= changed.includes(join(input.stateDir, 'egress-fence.nft'));
  pending.env ||= changed.includes(join(input.stateDir, 'celld.env'));
  if (!pending.rules && !pending.env) return;
  const wasActive = (name: string) => ['running', 'restarting'].includes(states.get(name) ?? '');
  pending.celld ||= wasActive('celld');
  // A profile transition needs a new proxy before recovering an active celld.
  // An existing exited proxy remains an operator's deliberate stopped state.
  pending.proxy ||=
    wasActive('gce-metadata-proxy') ||
    (pending.celld && !states.has('gce-metadata-proxy') && metadataProxyEnabled(input.box));
  // Atomic rename plus file/directory fsync must complete before either input is changed.
  if (existing) replacePrivateFile(marker, JSON.stringify(pending));
}

export async function writeAndReconcileFence(input: FenceReconcileInput): Promise<void> {
  const { stateDir, box } = input;
  const marker = join(stateDir, 'fence-reconcile-pending.json');
  const existing = ['egress-fence.nft', 'celld.env'].some((name) =>
    existsSync(join(stateDir, name))
  );
  const compose = composeRunner(input);
  // Discover before changing the bind mount. Fresh --init never contacts Docker.
  const states = serviceStates(existing, compose);
  const pending = pendingReconciliation(marker);
  await writeFenceFiles({
    ...input,
    beforeWrite: (changed) =>
      checkpointReconciliation(pending, changed, input, states, marker, existing),
  });
  if (!pending.rules && !pending.env) return;

  // Never start a deliberately stopped install. Retain pending work for its next active deploy.
  const active =
    ['running', 'restarting'].includes(states.get('egress-fence') ?? '') ||
    pending.celld ||
    pending.proxy;
  if (!active) return;
  try {
    reconcileServices(compose, pending, states, box);
    rmSync(marker);
  } catch {
    // Retain both pending inputs and original consumer intent for an unchanged-file retry.
    stopCredentialConsumers(compose, states);
    throw new Error(
      'fence reconciliation failed; credential consumers stopped where possible; retry deploy after repairing Compose'
    );
  }
}
