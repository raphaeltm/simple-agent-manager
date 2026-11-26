/**
 * Removes the installation-key resources from a deployment's Pulumi state, once, without
 * touching a key value (task 01M8C74NYMDP2YYPAG17VXJB78).
 *
 * The infra program no longer declares them, so on a stack that still has them a preview or update
 * would plan their deletion: refused (they are protected), and a deletion's preview carries the
 * RandomId's raw id. Instead, after the Worker is shown to hold every key by NAME
 * (installation-keys.ts), each allowlisted resource is unprotected and deleted from state. These
 * are random/tls resources that exist only in state, so nothing outside Pulumi changes, and the
 * Worker keeps the exact values it runs with: nothing is regenerated or rewritten.
 *
 * Previews that run while key resources may still be in state (dry runs and, later, takeover gates)
 * exclude them with `--exclude`, so they neither plan the deletion nor print or hold the ids. The
 * same allowlist drives both, matched on type AND name.
 *
 * The program also declares a protected, non-secret marker resource. A release from before this
 * change does not declare it, so its `pulumi up` fails on the protected delete and stops before
 * its configure-secrets.sh could overwrite the Worker's keys with new Pulumi-generated ones.
 *
 * CLI (repository root, Pulumi stack selected in infra/):
 *   pnpm exec tsx scripts/deploy/retire-key-resources.ts exclude-args   # preview flags, one per line
 *   CF_API_TOKEN=... CF_ACCOUNT_ID=... API_WORKER_NAME=... \
 *     pnpm exec tsx scripts/deploy/retire-key-resources.ts retire
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { isEntrypoint } from './entrypoint.js';
import {
  DEFAULT_CLOUDFLARE_API_BASE,
  InstallationKeysError,
  workerSecretNames,
} from './installation-keys.js';

const RANDOM_ID = 'random:index/randomId:RandomId';
const PRIVATE_KEY = 'tls:index/privateKey:PrivateKey';

/**
 * The resources that held installation keys, by Pulumi type and name, with the Worker secrets each
 * one was copied into. Before a resource leaves state, the Worker must hold those secrets: state is
 * then no longer the only copy. The retired trial secret was never a Worker secret any more.
 */
export const RETIRED_KEY_RESOURCES: ReadonlyArray<
  readonly [type: string, name: string, workerSecrets: readonly string[]]
> = [
  [RANDOM_ID, 'encryption-key', ['ENCRYPTION_KEY']],
  [
    RANDOM_ID,
    'deploy-signing-private-key',
    ['DEPLOY_SIGNING_PRIVATE_KEY', 'DEPLOY_SIGNING_PUBLIC_KEY'],
  ],
  [RANDOM_ID, 'preview-signing-key', ['PREVIEW_SIGNING_KEY']],
  [RANDOM_ID, 'trial-claim-token-secret', []],
  [PRIVATE_KEY, 'jwt-signing-key', ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY']],
  [PRIVATE_KEY, 'vapid-key', ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY']],
];

/** Declared by the program from this change on (infra/resources/secrets.ts). */
export const RETIREMENT_MARKER: readonly [type: string, name: string] = [
  RANDOM_ID,
  'installation-keys-retired',
];

const STACK_TYPE = 'pulumi:pulumi:Stack';

function isResource(urn: string, [type, name]: readonly [string, string, ...unknown[]]): boolean {
  return urn.endsWith(`::${type}::${name}`);
}

/** The allowlisted key resources present in a stack's URN list. */
export function presentKeyResources(urns: readonly string[]): string[] {
  return urns.filter((urn) => RETIRED_KEY_RESOURCES.some((resource) => isResource(urn, resource)));
}

/**
 * `--exclude` flags for a preview of the current program against this state: every key resource
 * still present and the marker. Empty for a stack with no resources (a fresh installation).
 */
export function previewExcludeArgs(urns: readonly string[]): string[] {
  const stackUrn = urns.find((urn) => urn.split('::')[2] === STACK_TYPE);
  if (!stackUrn) return [];
  const [prefix, project] = stackUrn.split('::');
  const marker = `${prefix}::${project}::${RETIREMENT_MARKER[0]}::${RETIREMENT_MARKER[1]}`;
  const excluded = [...presentKeyResources(urns), ...(urns.includes(marker) ? [] : [marker])];
  return excluded.flatMap((urn) => ['--exclude', urn]);
}

export interface RetireOptions {
  urns: readonly string[];
  /** The API Worker's secret names (never values). */
  workerSecretNames(): Promise<ReadonlySet<string>>;
  /** Runs `pulumi <args>` in the project directory; output is never shown. */
  pulumi(args: string[]): Promise<void>;
}

/** Retires every allowlisted key resource still in state; returns the URNs it removed. */
export async function retireKeyResources(options: RetireOptions): Promise<string[]> {
  const present = presentKeyResources(options.urns);
  if (present.length === 0) return [];
  // State may be the only other copy of a key: never remove a resource whose Worker secrets are
  // not all there. A group the Worker lacks and state never had is not this step's business.
  const names = await options.workerSecretNames();
  const missing = RETIRED_KEY_RESOURCES.filter((resource) =>
    present.some((urn) => isResource(urn, resource))
  ).flatMap(([, , secrets]) => secrets.filter((secret) => !names.has(secret)));
  if (missing.length)
    throw new InstallationKeysError(
      `Pulumi state still holds keys the API Worker does not have (${missing.join(', ')}), so ` +
        'nothing was removed from state. Do not create new keys for them: ask the installation owner.'
    );
  for (const urn of present) {
    await options.pulumi(['state', 'unprotect', urn, '--yes']);
    await options.pulumi(['state', 'delete', urn, '--yes']);
  }
  return present;
}

/** Executables by absolute path, never by a PATH lookup a writable directory could shadow. */
const BASH = '/bin/bash';

/** The Pulumi CLI the job installed: PULUMI_CLI_PATH must be absolute and outside the checkout. */
function pulumiCli(root: string): string {
  const path = process.env.PULUMI_CLI_PATH ?? '';
  if (!isAbsolute(path) || path.startsWith(`${root}/`) || !existsSync(path))
    throw new InstallationKeysError(
      'PULUMI_CLI_PATH must be the absolute path of the installed Pulumi CLI'
    );
  return path;
}

function stackUrns(infra: string, pulumi: string): string[] {
  const listed = spawnSync(BASH, [join(infra, '..', 'scripts/deploy/pulumi-stack-urns.sh')], {
    cwd: infra,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    // The lister runs `pulumi`; it gets this exact CLI's directory first.
    env: { ...process.env, PATH: `${dirname(pulumi)}:/usr/bin:/bin` },
  });
  if (listed.status !== 0) throw new InstallationKeysError('Could not list the Pulumi stack');
  return listed.stdout.split('\n').filter(Boolean);
}

async function main(): Promise<void> {
  const root = resolve('.');
  const infra = join(root, 'infra');
  const pulumi = pulumiCli(root);
  const urns = stackUrns(infra, pulumi);
  const command = process.argv[2];
  if (command === 'exclude-args') {
    for (const arg of previewExcludeArgs(urns)) console.log(arg);
    return;
  }
  if (command !== 'retire')
    throw new InstallationKeysError('Usage: retire-key-resources.ts exclude-args|retire');
  const retired = await retireKeyResources({
    urns,
    workerSecretNames: () =>
      workerSecretNames({
        request: (url, init) => fetch(url, init),
        apiBase: process.env.CLOUDFLARE_API_BASE_URL || DEFAULT_CLOUDFLARE_API_BASE,
        accountId: process.env.CF_ACCOUNT_ID ?? '',
        token: process.env.CF_API_TOKEN ?? '',
        worker: process.env.API_WORKER_NAME ?? '',
      }),
    async pulumi(args) {
      const run = spawnSync(pulumi, args, { cwd: infra, stdio: 'ignore' });
      if (run.status !== 0)
        throw new InstallationKeysError(
          `pulumi ${args.slice(0, 2).join(' ')} ${args[2]} exited ${run.status}`
        );
    },
  });
  console.log(
    retired.length
      ? `Retired ${retired.length} installation-key resource(s) from Pulumi state:\n${retired.join('\n')}`
      : 'No installation-key resources in Pulumi state.'
  );
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof InstallationKeysError ? error.message : 'retire-key-resources failed'
    );
    process.exitCode = 1;
  });
}
