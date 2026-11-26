/**
 * Installation keys of a self-hosted Cloudflare install: created once, straight into the API
 * Worker's secrets, and never read, exported or printed by anything afterwards.
 *
 * Raphaël, 2026-11-26: keys live only inside Cloudflare ("I'd rather risk losing all keys than
 * exposing them... Nobody ever sees the key"). So nothing here returns, logs or hands on a key
 * value: generation happens in this process, the values go to Cloudflare's secrets API in one
 * request body, and the function returns nothing. Inspection reads secret NAMES only (the list
 * endpoint never returns values).
 *
 * Keys are minted only for a brand-new installation, decided on the condition itself
 * (.claude/rules/74): the Worker holds none of the keys AND the installation's database has no
 * users, so nothing can be encrypted or signed under an earlier key. Any other state refuses:
 * replacing ENCRYPTION_KEY makes every stored credential unreadable.
 *
 * Usage (on a machine the operator owns, never CI):
 *   CF_API_TOKEN=... CF_ACCOUNT_ID=... API_WORKER_NAME=... D1_DATABASE_ID=... \
 *     pnpm exec tsx scripts/deploy/installation-keys.ts create [--new-installation]
 *   CF_API_TOKEN=... CF_ACCOUNT_ID=... API_WORKER_NAME=... \
 *     pnpm exec tsx scripts/deploy/installation-keys.ts check
 *   wrangler secret list --format json | pnpm exec tsx scripts/deploy/installation-keys.ts check-listing
 */
import { randomBytes } from 'node:crypto';

import { generateDeploySigningKeyPair } from './deploy-signing-keys.js';
import { isEntrypoint } from './entrypoint.js';
import { generateEncryptionKey, generateKeyPair, generateVapidKeyPair } from './generate-keys.js';

export const DEFAULT_CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** One key, or the two halves of one key pair, which are only ever created together. */
interface KeyGroup {
  names: readonly string[];
  generate(): Record<string, string>;
}

/** Same shapes as the Pulumi resources they replace and as the self-hosted VM install's keys. */
export const INSTALLATION_KEY_GROUPS: readonly KeyGroup[] = [
  { names: ['ENCRYPTION_KEY'], generate: () => ({ ENCRYPTION_KEY: generateEncryptionKey() }) },
  {
    names: ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'],
    generate: () => {
      const pair = generateKeyPair();
      return { JWT_PRIVATE_KEY: pair.privateKey, JWT_PUBLIC_KEY: pair.publicKey };
    },
  },
  {
    names: ['DEPLOY_SIGNING_PRIVATE_KEY', 'DEPLOY_SIGNING_PUBLIC_KEY'],
    generate: () => {
      const pair = generateDeploySigningKeyPair();
      return {
        DEPLOY_SIGNING_PRIVATE_KEY: pair.privateKey,
        DEPLOY_SIGNING_PUBLIC_KEY: pair.publicKey,
      };
    },
  },
  {
    names: ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY'],
    generate: () => {
      const pair = generateVapidKeyPair();
      return { VAPID_PRIVATE_KEY: pair.privateKey, VAPID_PUBLIC_KEY: pair.publicKey };
    },
  },
  {
    names: ['PREVIEW_SIGNING_KEY'],
    generate: () => ({ PREVIEW_SIGNING_KEY: randomBytes(32).toString('base64') }),
  },
];

export const INSTALLATION_KEY_NAMES: readonly string[] = INSTALLATION_KEY_GROUPS.flatMap(
  (group) => group.names
);

export interface WorkerAccess {
  request(url: string, init?: RequestInit): Promise<Response>;
  apiBase: string;
  accountId: string;
  token: string;
  worker: string;
}

/** A refusal or failure. Its message names secrets and HTTP statuses, never a value. */
export class InstallationKeysError extends Error {}

export type KeyInspection =
  { state: 'complete' } | { state: 'absent' } | { state: 'incomplete'; missing: string[] };

async function cloudflare(access: WorkerAccess, path: string, init?: RequestInit) {
  const response = await access.request(`${access.apiBase}/accounts/${access.accountId}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${access.token}`, ...init?.headers },
  });
  // Only the status and Cloudflare's numeric error code: a body or message is never echoed.
  if (!response.ok) {
    const code = await response
      .json()
      .then((body: unknown) => (body as { errors?: Array<{ code?: unknown }> }).errors?.[0]?.code)
      .catch(() => undefined);
    throw new InstallationKeysError(
      `Cloudflare API ${path.split('/')[0]} returned ${response.status}` +
        (typeof code === 'number' ? ` (error ${code})` : '')
    );
  }
  const body = (await response.json()) as { success?: unknown; result?: unknown };
  if (body.success !== true)
    throw new InstallationKeysError(`Cloudflare API ${path.split('/')[0]} failed`);
  return body.result;
}

/** Which installation keys a Worker secrets listing (`[{ name, type }]`, names only) contains. */
export function inspectSecretListing(listing: unknown): KeyInspection {
  if (!Array.isArray(listing)) throw new InstallationKeysError('Invalid Worker secrets listing');
  const present = new Set(
    listing
      .map((entry: { name?: unknown } | null) => entry?.name)
      .filter((name): name is string => typeof name === 'string')
  );
  const missing = INSTALLATION_KEY_NAMES.filter((name) => !present.has(name));
  if (missing.length === 0) return { state: 'complete' };
  if (missing.length === INSTALLATION_KEY_NAMES.length) return { state: 'absent' };
  return { state: 'incomplete', missing };
}

/** The Worker's secret names (the listing endpoint never returns values). */
export async function workerSecretNames(access: WorkerAccess): Promise<ReadonlySet<string>> {
  const listing = await cloudflare(access, `workers/scripts/${access.worker}/secrets`);
  inspectSecretListing(listing);
  return new Set(
    (listing as Array<{ name?: unknown } | null>)
      .map((entry) => entry?.name)
      .filter((name): name is string => typeof name === 'string')
  );
}

/** Which installation keys the Worker holds, by name only. */
export async function inspectInstallationKeys(access: WorkerAccess): Promise<KeyInspection> {
  return inspectSecretListing(await cloudflare(access, `workers/scripts/${access.worker}/secrets`));
}

/** Throws, naming the missing secrets, unless the inspection is complete. */
export function assertComplete(inspection: KeyInspection, worker: string): void {
  if (inspection.state === 'complete') return;
  const missing = inspection.state === 'absent' ? [...INSTALLATION_KEY_NAMES] : inspection.missing;
  throw new InstallationKeysError(
    `API Worker ${worker} is missing installation keys: ${missing.join(', ')}. ` +
      'Deploys never create or replace keys. A brand-new installation gets them from the ' +
      'installer, or from `pnpm exec tsx scripts/deploy/installation-keys.ts create ' +
      '--new-installation` run on a machine you own (see the self-hosting guide).'
  );
}

/** Fails unless the Worker holds every installation key. Never creates one. */
export async function requireInstallationKeys(access: WorkerAccess): Promise<void> {
  assertComplete(await inspectInstallationKeys(access), access.worker);
}

/**
 * True when the installation's database holds a real user or a stored credential, either of which
 * means data may be encrypted under an earlier key. The `users` table always holds the
 * `status = 'system'` sentinel row from migration 0043, which is not a person and owns no data, so
 * it is excluded (.claude/rules/40-sentinel-rows-excluded-from-counts.md). No migration seeds
 * `credentials` or `platform_credentials`.
 */
export const INSTALLATION_DATA_EXISTS_SQL =
  "SELECT 1 AS present FROM users WHERE status IS NOT 'system' " +
  'UNION ALL SELECT 1 FROM credentials UNION ALL SELECT 1 FROM platform_credentials LIMIT 1';

async function databaseHasData(access: WorkerAccess, databaseId: string): Promise<boolean> {
  const result = await cloudflare(access, `d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: INSTALLATION_DATA_EXISTS_SQL }),
  });
  const rows = Array.isArray(result) ? (result[0] as { results?: unknown })?.results : undefined;
  if (!Array.isArray(rows)) throw new InstallationKeysError('Invalid database query result');
  return rows.length > 0;
}

/**
 * Creates the installation keys the API Worker does not have, in one request, so a failure leaves
 * none written. Only whole groups are created: a key pair with one half present is refused, and
 * nothing present is ever replaced. ENCRYPTION_KEY is created only for a brand-new installation
 * (every key absent, `freshInstallation`, and a database with no real users or credentials): a
 * new one would make every stored credential unreadable. The other groups protect no stored data,
 * so an installation from before a group existed gets that group the way earlier releases
 * generated it. Returns the names created, never a value.
 *
 * Not atomic against a concurrent create for the same Worker (the secrets API has no
 * compare-and-set): the names are re-read immediately before the write, and only one installer or
 * operator should set up an installation at a time.
 */
export async function createInstallationKeys(
  access: WorkerAccess & { databaseId: string },
  options: { freshInstallation?: boolean; groups?: readonly KeyGroup[] } = {}
): Promise<string[]> {
  const groups = options.groups ?? INSTALLATION_KEY_GROUPS;
  const plan = async () => {
    const present = await workerSecretNames(access);
    const halves = groups.filter(
      (group) =>
        group.names.some((name) => present.has(name)) &&
        !group.names.every((name) => present.has(name))
    );
    if (halves.length)
      throw new InstallationKeysError(
        `API Worker ${access.worker} holds only part of a key pair (${halves.flatMap((group) => group.names).join(', ')}); refusing to create keys`
      );
    return groups.filter((group) => group.names.every((name) => !present.has(name)));
  };
  const missing = await plan();
  if (!missing.length) return [];
  if (missing.some((group) => group.names.includes('ENCRYPTION_KEY'))) {
    if (!options.freshInstallation || missing.length !== groups.length)
      throw new InstallationKeysError(
        `API Worker ${access.worker} has no ENCRYPTION_KEY; it is never created for an existing installation, because a new one makes stored credentials unreadable`
      );
    if (await databaseHasData(access, access.databaseId))
      throw new InstallationKeysError(
        `The database of ${access.worker} already has users or credentials, so data may be encrypted under an earlier key; refusing to create new installation keys`
      );
  }
  // Re-read right before the write, so a run that raced this one is caught where it can be.
  if ((await plan()).length !== missing.length)
    throw new InstallationKeysError(
      `API Worker ${access.worker} changed while its keys were being created`
    );
  const secrets: Record<string, { name: string; text: string; type: 'secret_text' }> = {};
  for (const group of missing)
    for (const [name, text] of Object.entries(group.generate()))
      secrets[name] = { name, text, type: 'secret_text' };
  // Same endpoint as `wrangler secret bulk`: one new Worker version with every secret, or none.
  await cloudflare(access, `workers/scripts/${access.worker}/secrets-bulk`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body: JSON.stringify({ secrets }),
  });
  return Object.keys(secrets);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new InstallationKeysError(`${name} is required`);
  return value;
}

async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'check-listing') {
    // `wrangler secret list --format json` on stdin: names and types only, never values.
    let listing: unknown;
    try {
      // Tolerate a notice before the JSON; a wrong listing still fails closed.
      const text = await readStdin();
      listing = JSON.parse(text.slice(Math.max(0, text.indexOf('['))));
    } catch {
      throw new InstallationKeysError('Could not read the Worker secrets listing');
    }
    assertComplete(inspectSecretListing(listing), process.argv[3] || 'the API Worker');
    console.log(`All ${INSTALLATION_KEY_NAMES.length} installation keys are present.`);
    return;
  }
  const access: WorkerAccess = {
    request: (url, init) => fetch(url, init),
    apiBase: process.env.CLOUDFLARE_API_BASE_URL || DEFAULT_CLOUDFLARE_API_BASE,
    accountId: requiredEnv('CF_ACCOUNT_ID'),
    token: requiredEnv('CF_API_TOKEN'),
    worker: requiredEnv('API_WORKER_NAME'),
  };
  if (command === 'check') {
    await requireInstallationKeys(access);
    console.log(
      `API Worker ${access.worker} has all ${INSTALLATION_KEY_NAMES.length} installation keys.`
    );
  } else if (command === 'create') {
    // Policy 795e72a6: key material is never generated or handled in CI.
    if (process.env.GITHUB_ACTIONS === 'true' || process.env.CI)
      throw new InstallationKeysError('Installation keys are never created in CI');
    const created = await createInstallationKeys(
      { ...access, databaseId: requiredEnv('D1_DATABASE_ID') },
      { freshInstallation: process.argv.includes('--new-installation') }
    );
    console.log(
      created.length
        ? `Created ${created.join(', ')} on API Worker ${access.worker}.`
        : `API Worker ${access.worker} already has every installation key.`
    );
  } else {
    throw new InstallationKeysError('Usage: installation-keys.ts check|create');
  }
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof InstallationKeysError ? error.message : 'installation-keys failed'
    );
    process.exitCode = 1;
  });
}
