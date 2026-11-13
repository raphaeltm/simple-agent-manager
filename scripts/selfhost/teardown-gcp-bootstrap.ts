/**
 * The bootstrap half of teardown's Google Cloud adapter (teardown-gcp.ts): the workload identity,
 * node service account and KMS key that `pnpm selfhost:gcp-bootstrap` recorded, removed by the
 * bootstrap's own teardown (deploy/selfhost/gcp-teardown.sh), which proves each one this
 * install's again first. An install from before the record is searched by the exact names the
 * bootstrap derives for this issuer, and those are shown as "discovered, not recorded".
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { addResource, readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { check } from './backup-lib';
import type { TeardownContext } from './teardown-box';
import { both, type Decision, type Item, type Mode, STEPS } from './teardown-model';

export const BOOTSTRAP = 'gcp-bootstrap';
const KEY_RING = 'sam-selfhost';
const PROVIDER_ID = 'sam-api';
const NODE_ACCOUNT = 'sam-nodes';

/** Runs gcloud; a missing gcloud reads as a failed command (status 127), not a crash. */
/**
 * True when gcloud said the resource does not exist. Any other failure (permission denied, network,
 * auth) means teardown could not check, which must be reported rather than read as "absent".
 */
export function gcloudNotFound(stderr: string): boolean {
  return /not found|NOT_FOUND|notFound|does not exist/i.test(stderr);
}

/** The first `ERROR:` line of a gcloud failure, for a "could not check" item. */
export function gcloudReason(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.includes('ERROR')) ?? stderr.split('\n')[0] ?? '';
  return line.trim().slice(0, 200) || 'gcloud failed';
}

export function gcloud(ctx: TeardownContext, args: string[]) {
  try {
    return ctx.run('gcloud', args);
  } catch (error) {
    // spawn failure: gcloud is not installed
    return {
      status: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function installHash(issuer: string): string {
  return createHash('sha256').update(issuer).digest('hex').slice(0, 8);
}

function isKms(kind: string, name: string): boolean {
  return (
    kind === 'kms-key' ||
    kind === 'kms-key-ring' ||
    (kind === 'iam-binding' && name.includes('/cryptoKeys/'))
  );
}

function bootstrapPlan(ctx: TeardownContext, kind: string, name: string): Record<Mode, Decision> {
  const kms = isKms(kind, name);
  const key = kind === 'kms-key' || kind === 'kms-key-ring';
  return {
    'keep-data': kms
      ? { act: 'keep', why: "keep my data keeps the key and the box's use of it" }
      : { act: 'remove' },
    'remove-everything':
      key && !ctx.options.destroyKey
        ? { act: 'keep', why: "pass --destroy-key to schedule the key's destruction" }
        : { act: 'remove' },
  };
}

const KEY_FOR_GOOD =
  'every sealed bundle and every backup sealed with this key becomes unrecoverable once destruction completes (30 days by default; gcloud kms keys versions restore undoes it until then)';

export function bootstrapItems(ctx: TeardownContext, project: string): Item[] {
  const issuer = `https://api.${ctx.domain}`;
  const entries = ctx.record.filter(
    (r) => r.cloud === 'gcp' && r.createdBy === BOOTSTRAP && r.attributes?.project === project
  );
  const { found: discovered, unchecked } =
    entries.length === 0 && ctx.domain
      ? discoverBootstrap(ctx, project, issuer)
      : { found: [], unchecked: [] };
  const runKey = `gcp-bootstrap:${project}`;
  let output = '';
  const run = () => {
    for (const d of discovered) {
      addResource(ctx.recordFile, {
        cloud: 'gcp',
        kind: d.kind,
        name: d.name,
        action: 'created',
        createdBy: BOOTSTRAP,
        attributes: { project, install: issuer, discovered: 'by-name' },
      });
    }
    output = runBootstrapTeardown(ctx, project, issuer, [...entries, ...discovered]);
  };
  const settle = (kind: string, name: string) => () => {
    const entry = readRecord(ctx.recordFile).resources.find(
      (r) => r.cloud === 'gcp' && r.kind === kind && r.name === name
    );
    if (entry?.removedAt) return { removed: true };
    const line = output
      .split('\n')
      .find((l) => l.includes(name.split('#')[0] ?? name) && l.trim().startsWith('-'));
    return {
      removed: false,
      why: line?.trim().replace(/^- /, '') ?? 'left by the bootstrap teardown',
    };
  };
  const how = `pnpm selfhost:gcp-bootstrap -- --project ${project} --api-url ${issuer} --teardown, which proves each one this install's again`;
  const items: Item[] = entries.map((entry) => ({
    id: `gcp:${entry.kind}:${entry.name}`,
    place: 'in your cloud, made by the bootstrap',
    what: `${entry.kind} ${entry.name}`,
    provenance: 'recorded',
    how,
    step: STEPS.identity,
    plan:
      entry.action === 'reused'
        ? both({ act: 'keep', why: 'it existed before the bootstrap' })
        : bootstrapPlan(ctx, entry.kind, entry.name),
    forGood: entry.kind === 'kms-key' ? KEY_FOR_GOOD : undefined,
    removedAt: entry.removedAt,
    runKey,
    run,
    settle: settle(entry.kind, entry.name),
  }));
  for (const d of discovered) {
    items.push({
      id: `gcp:${d.kind}:${d.name}`,
      place: 'in your cloud, made by the bootstrap',
      what: `${d.kind} ${d.name} (${d.proof})`,
      provenance: 'discovered, not recorded',
      how: `${how}; --adopt-discovered records it first`,
      step: STEPS.identity,
      plan: ctx.options.adoptDiscovered
        ? bootstrapPlan(ctx, d.kind, d.name)
        : both({
            act: 'keep',
            why: 'discovered, not recorded: pass --adopt-discovered to remove it',
          }),
      forGood: d.kind === 'kms-key' ? KEY_FOR_GOOD : undefined,
      runKey,
      run,
      settle: settle(d.kind, d.name),
    });
  }
  if (unchecked.length > 0) {
    items.push({
      id: `gcp:${project}:bootstrap-unchecked`,
      place: 'in your cloud, made by the bootstrap',
      what: `could not check ${unchecked.map((u) => u.name).join(', ')} (${unchecked[0]?.reason})`,
      provenance: 'discovered, not recorded',
      how: `run again with gcloud logged in as a project owner, or ${how} where the bootstrap ran (its record is there)`,
      step: STEPS.identity,
      plan: both({
        act: 'operator',
        why: 'teardown could not check them with this gcloud account',
      }),
    });
  }
  return items;
}

interface Discovered {
  kind: string;
  name: string;
  proof: string;
}

/**
 * An install from before the record: only the exact names the bootstrap derives for this issuer,
 * each with the same proof its teardown checks (description naming the issuer, provider trusting
 * it, key labelled sam-install=<hash>).
 */
function discoverBootstrap(
  ctx: TeardownContext,
  project: string,
  issuer: string
): { found: Discovered[]; unchecked: Array<{ name: string; reason: string }> } {
  const hash = installHash(issuer);
  const pool = `sam-${hash}`;
  const found: Discovered[] = [];
  const unchecked: Array<{ name: string; reason: string }> = [];
  const value = (args: string[], name: string) => {
    const r = gcloud(ctx, args);
    if (r.status === 0) return r.stdout.trim();
    if (!gcloudNotFound(r.stderr)) unchecked.push({ name, reason: gcloudReason(r.stderr) });
    return null;
  };
  const poolName = `projects/${project}/locations/global/workloadIdentityPools/${pool}`;
  const poolDescription = value(
    [
      'iam',
      'workload-identity-pools',
      'describe',
      pool,
      `--project=${project}`,
      '--location=global',
      '--format=value(description)',
    ],
    `workload identity pool ${pool}`
  );
  if (poolDescription?.endsWith(issuer)) {
    const providerIssuer = value(
      [
        'iam',
        'workload-identity-pools',
        'providers',
        'describe',
        PROVIDER_ID,
        `--project=${project}`,
        '--location=global',
        `--workload-identity-pool=${pool}`,
        '--format=value(oidc.issuerUri)',
      ],
      `provider ${PROVIDER_ID}`
    );
    if (providerIssuer === issuer) {
      found.push({
        kind: 'workload-identity-provider',
        name: `${poolName}/providers/${PROVIDER_ID}`,
        proof: `trusts ${issuer}`,
      });
    }
    found.push({
      kind: 'workload-identity-pool',
      name: poolName,
      proof: `description names ${issuer}`,
    });
  }
  const email = `${NODE_ACCOUNT}@${project}.iam.gserviceaccount.com`;
  const saDescription = value(
    [
      'iam',
      'service-accounts',
      'describe',
      email,
      `--project=${project}`,
      '--format=value(description)',
    ],
    `service account ${email}`
  );
  if (saDescription?.endsWith(issuer)) {
    for (const role of ['roles/compute.instanceAdmin.v1', 'roles/compute.securityAdmin']) {
      found.push({
        kind: 'iam-binding',
        name: `projects/${project}#${role}#serviceAccount:${email}`,
        proof: `granted to ${email}`,
      });
    }
    found.push({ kind: 'service-account', name: email, proof: `description names ${issuer}` });
  }
  const keyLabel = value(
    [
      'kms',
      'keys',
      'describe',
      pool,
      `--keyring=${KEY_RING}`,
      '--location=global',
      `--project=${project}`,
      '--format=value(labels.sam-install)',
    ],
    `KMS key ${KEY_RING}/${pool}`
  );
  if (keyLabel === hash) {
    found.push({
      kind: 'kms-key',
      name: `projects/${project}/locations/global/keyRings/${KEY_RING}/cryptoKeys/${pool}`,
      proof: `labelled sam-install=${hash}`,
    });
  }
  return { found, unchecked };
}

function runBootstrapTeardown(
  ctx: TeardownContext,
  project: string,
  issuer: string,
  entries: Array<{ kind: string; name: string }>
): string {
  const args = [
    join(ctx.selfhostDir, 'gcp-bootstrap.sh'),
    '--project',
    project,
    '--api-url',
    issuer,
    '--teardown',
    '--state-dir',
    ctx.stateDir,
  ];
  if (ctx.mode === 'keep-data') args.push('--keep-kms');
  const key = entries.find((e) => e.kind === 'kms-key');
  if (ctx.mode === 'remove-everything' && ctx.options.destroyKey && key) {
    args.push('--destroy-key-versions', key.name.split('/').pop() ?? '');
  }
  const result = ctx.run('bash', args);
  ctx.log(`gcp-bootstrap teardown (${project}):\n${result.stdout.trimEnd()}`);
  check(result, 'gcp-bootstrap --teardown');
  return result.stdout;
}
