/**
 * Adoption: an installation service taking over a SAM deployment that something else created (a
 * fork's GitHub Actions deploy, or SAM's own staging and production). Every rule here keeps the
 * existing deployment exactly as it is: its state, keys, settings and data.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as TOML from '@iarna/toml';

import { D1_MIGRATION_ALIAS_REPAIRS } from './d1-migration-aliases.js';
import { EngineCommandFailure } from './installer-engine-contract.js';
import { OMITTED_WORKER_VAR_DEFAULTS } from './worker-var-defaults.js';
import { WORKER_VAR_OVERRIDE_NAMES } from './worker-var-override-names.js';

/**
 * Pulumi operations that change nothing. Anything else (create, delete, replace, import, discard
 * and their variants) means the stack is not the deployment the owner described, or the approved
 * source would reshape it, so the takeover stops before `pulumi up`.
 */
const TAKEOVER_UNCHANGING_OPERATIONS = new Set(['same', 'read', 'refresh']);
/**
 * Resource types a takeover may update in place. Cloudflare's provider rewrites the Pages project
 * on every deploy: a routine deploy of an unchanged SAM reports it as its one in-place update, so
 * refusing it would refuse every takeover. It holds no data, and every deploy republishes it. An
 * in-place update of anything else (a database, bucket, lifecycle rule, DNS record, route, key or
 * certificate) would reconfigure the existing deployment and is refused like a replacement.
 */
const TAKEOVER_UPDATABLE_TYPES = new Set(['cloudflare:index/pagesProject:PagesProject']);
const MAX_REFUSAL_LINES = 30;

/**
 * Key material a deployment may have supplied as a GitHub-secret override instead of the value
 * Pulumi generated (`configure-secrets.sh` prefers the override). An adopted installation has no
 * GitHub secrets, so writing Pulumi's value would replace a working key: every stored credential
 * would become unreadable and every session invalid, with no way to read the override back. An
 * existing Worker secret with one of these names is therefore kept, on the takeover and on every
 * later update of an adopted installation.
 */
export const PRESERVED_KEY_SECRETS = [
  'ENCRYPTION_KEY',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'PREVIEW_SIGNING_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_SUBJECT',
  'BETTER_AUTH_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'DEPLOY_SIGNING_PRIVATE_KEY',
  'DEPLOY_SIGNING_PUBLIC_KEY',
] as const;

/**
 * Halves of one key. Keeping one half while writing Pulumi's other half would leave a pair that
 * does not match, so if the Worker holds either half both are kept.
 */
const KEY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'],
  ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY'],
  ['DEPLOY_SIGNING_PRIVATE_KEY', 'DEPLOY_SIGNING_PUBLIC_KEY'],
];
const MAX_REFUSAL_LINE_CHARS = 300;

/** Worker vars the engine computes for every deploy; a deployed value must never replace them. */
const ENGINE_OWNED_VARS = new Set(['VM_AGENT_REQUIRED_VERSION']);

/** A takeover refusal. Its tail names what would change; it never carries secret values. */
export class AdoptionRefused extends EngineCommandFailure {
  constructor(lines: string[]) {
    super(
      null,
      null,
      lines.slice(0, MAX_REFUSAL_LINES).map((line) => line.slice(0, MAX_REFUSAL_LINE_CHARS))
    );
    this.message = 'Takeover refused';
  }
}

/** `urn:pulumi:<stack>::<project>::<type>::<name>` as its type and name. */
function urnParts(urn: unknown): { type: string; name: string } | undefined {
  if (typeof urn !== 'string') return undefined;
  const parts = urn.split('::');
  return parts.length >= 4 ? { type: parts[2], name: parts.slice(3).join('::') } : undefined;
}

function urnLabel(urn: unknown): string {
  const parts = urnParts(urn);
  return parts ? `${parts.type} ${parts.name}` : 'unknown resource';
}

/**
 * The steps of a `pulumi preview --json` document that a takeover must not perform, one line each
 * (`<operation> <type> <name>`). Throws on a document that is not a preview, so an unreadable
 * preview can never pass as an empty one.
 */
export function refusedTakeoverSteps(preview: unknown): string[] {
  if (
    !preview ||
    typeof preview !== 'object' ||
    !Array.isArray((preview as { steps?: unknown }).steps)
  )
    throw new Error('Invalid infrastructure preview');
  const refused: string[] = [];
  for (const step of (preview as { steps: unknown[] }).steps) {
    const op = (step as { op?: unknown } | null)?.op;
    if (typeof op !== 'string') throw new Error('Invalid infrastructure preview');
    const urn = (step as { urn?: unknown }).urn;
    const allowed =
      TAKEOVER_UNCHANGING_OPERATIONS.has(op) ||
      (op === 'update' && TAKEOVER_UPDATABLE_TYPES.has(urnParts(urn)?.type ?? ''));
    if (!allowed) refused.push(`${op} ${urnLabel(urn)}`);
  }
  return refused;
}

interface CloudflareAccess {
  request(url: string, init?: RequestInit): Promise<Response>;
  apiBase: string;
  accountId: string;
  token: string;
}

async function cloudflareResult(access: CloudflareAccess, path: string, init?: RequestInit) {
  const response = await access.request(`${access.apiBase}/accounts/${access.accountId}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${access.token}`, ...init?.headers },
  });
  if (response.status === 404) return { found: false as const };
  if (!response.ok) throw new Error('Cloudflare inspection failed');
  const body = (await response.json()) as { success?: unknown; result?: unknown };
  if (body.success !== true) throw new Error('Cloudflare inspection failed');
  return { found: true as const, result: body.result };
}

/**
 * The override vars the deployed API Worker runs with. On the fork path a GitHub Environment
 * supplied them; an adopted installation keeps them by reading them back from the Worker, which
 * `wrangler deploy` would otherwise reset to the checked-in defaults.
 */
export async function deployedWorkerOverrideVars(
  access: CloudflareAccess & { worker: string }
): Promise<Record<string, string>> {
  const settings = await cloudflareResult(access, `workers/scripts/${access.worker}/settings`);
  if (!settings.found) throw new Error('Adopted API Worker not found');
  const bindings = (settings.result as { bindings?: unknown } | undefined)?.bindings;
  if (!Array.isArray(bindings)) throw new Error('Invalid Worker settings');
  const names = new Set(WORKER_VAR_OVERRIDE_NAMES.filter((name) => !ENGINE_OWNED_VARS.has(name)));
  const vars: Record<string, string> = {};
  for (const binding of bindings as Array<{ type?: unknown; name?: unknown; text?: unknown }>) {
    if (
      binding?.type === 'plain_text' &&
      typeof binding.name === 'string' &&
      names.has(binding.name) &&
      typeof binding.text === 'string'
    )
      vars[binding.name] = binding.text;
  }
  return vars;
}

/**
 * Copies deployed overrides into the deploy environment without replacing a value already set.
 * A deployed value equal to the approved source's own default (its `[vars]` entry, or the code
 * default recorded for a var it omits) is not an override: carrying it would pin that default.
 *
 * Known limit (idea 01M8C88CXH9YTBZ4X3TDN1GP7J): overrides are inferred against the source being
 * deployed, on every deploy. When a release changes a default, the value the previous release
 * wrote no longer equals it, is taken for an override, and stays pinned. Fixing that needs a
 * record of the override names made at takeover; where it lives is not decided.
 */
export function carryDeployedVars(
  env: NodeJS.ProcessEnv,
  deployed: Record<string, string>,
  defaults: { checkedIn: Record<string, unknown>; code: Readonly<Record<string, string>> }
): string[] {
  const sourceDefault = (name: string) => {
    if (Object.hasOwn(defaults.checkedIn, name)) return String(defaults.checkedIn[name]);
    return Object.hasOwn(defaults.code, name) ? defaults.code[name] : undefined;
  };
  const carried: string[] = [];
  for (const [name, value] of Object.entries(deployed)) {
    if (env[name] !== undefined || sourceDefault(name) === value) continue;
    env[name] = value;
    carried.push(name);
  }
  return carried;
}

/** Names (never values) of the key secrets the deployed API Worker already holds. */
export async function existingPreservedKeySecrets(
  access: CloudflareAccess & { worker: string }
): Promise<string[]> {
  const secrets = await cloudflareResult(access, `workers/scripts/${access.worker}/secrets`);
  if (!secrets.found) throw new Error('Adopted API Worker not found');
  if (!Array.isArray(secrets.result)) throw new Error('Invalid Worker secrets listing');
  const present = new Set(
    (secrets.result as Array<{ name?: unknown }>)
      .map((entry) => entry?.name)
      .filter((name): name is string => typeof name === 'string')
  );
  for (const pair of KEY_PAIRS)
    if (pair.some((name) => present.has(name))) for (const name of pair) present.add(name);
  return PRESERVED_KEY_SECRETS.filter((name) => present.has(name));
}

/**
 * The D1 databases of a deployment, each with its own migration ledger and directory
 * (apps/api/wrangler.toml). The observability database is newer than the primary one, so a
 * deployment from before it existed has no output for it; the preview gate then refuses its
 * creation.
 */
const MIGRATION_LEDGERS = [
  {
    binding: 'DATABASE',
    output: 'd1DatabaseId',
    directory: 'apps/api/src/db/migrations',
    label: '',
    required: true,
  },
  {
    binding: 'OBSERVABILITY_DATABASE',
    output: 'observabilityD1DatabaseId',
    directory: 'apps/api/src/db/migrations/observability',
    label: 'observability/',
    required: false,
  },
] as const;

/**
 * Migrations a deployed database has applied that the approved source does not contain. Any
 * entry means the running SAM is newer than the source, and deploying it would be a rollback.
 * A migration applied under a legacy file name counts as its current file.
 */
export async function migrationsNewerThanSource(
  access: CloudflareAccess & {
    databaseId: string;
    root: string;
    binding: string;
    directory: string;
  }
): Promise<string[]> {
  const directory = join(access.root, access.directory);
  const local = new Set(
    existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.sql')) : []
  );
  for (const alias of D1_MIGRATION_ALIAS_REPAIRS)
    if (alias.binding === access.binding && local.has(alias.currentName))
      local.add(alias.legacyName);
  const query = await cloudflareResult(access, `d1/database/${access.databaseId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT name FROM d1_migrations ORDER BY id' }),
  });
  if (!query.found) throw new Error('Adopted database not found');
  const rows = Array.isArray(query.result)
    ? (query.result[0] as { results?: unknown } | undefined)?.results
    : undefined;
  if (!Array.isArray(rows)) throw new Error('Invalid database migration listing');
  return (rows as Array<{ name?: unknown }>)
    .map((row) => row?.name)
    .filter((name): name is string => typeof name === 'string' && !local.has(name));
}

/**
 * Takeover step 1, before anything changes: no deployed database may be newer than the approved
 * source, or this deploy would run older code on a newer schema.
 */
export async function refuseRollback(
  access: CloudflareAccess & { root: string; stackOutputs(): Promise<string> }
): Promise<void> {
  const parsed: unknown = JSON.parse(await access.stackOutputs());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid infrastructure outputs');
  const outputs = parsed as Record<string, unknown>;
  const newer: string[] = [];
  for (const ledger of MIGRATION_LEDGERS) {
    const databaseId = outputs[ledger.output];
    if (databaseId === undefined && !ledger.required) continue;
    if (typeof databaseId !== 'string' || !/^[0-9a-f-]{36}$/.test(databaseId))
      throw new Error('Adopted stack has no database');
    const names = await migrationsNewerThanSource({ ...access, ...ledger, databaseId });
    newer.push(...names.map((name) => ledger.label + name));
  }
  if (newer.length)
    throw new AdoptionRefused([
      'This SAM runs a newer version than the approved source. Its database has migrations the source does not contain:',
      ...newer,
    ]);
}

/** Takeover step 2, before the state refresh and `pulumi up`: no resource may change shape. */
export async function refuseResourceChanges(
  preview: () => Promise<string>,
  reason = 'The approved source would change these resources, so nothing was changed:'
): Promise<void> {
  let document: string;
  try {
    document = await preview();
  } catch (error) {
    if (!(error instanceof EngineCommandFailure)) throw error;
    // The preview's output is resource state, where a RandomId's `id` is a raw key, so nothing
    // the tool printed may reach the failure report, whatever the runner put in its tail.
    throw new AdoptionRefused([
      'The takeover check could not finish, so nothing was changed: the infrastructure preview failed. Its output is withheld because it can contain key values.',
    ]);
  }
  const refused = refusedTakeoverSteps(JSON.parse(document));
  if (refused.length) throw new AdoptionRefused([reason, ...refused]);
}

/**
 * Every adopted deploy keeps what the deployment already runs with: its override vars, and its
 * key secrets (configure-secrets.sh leaves the names in PRESERVE_EXISTING_WORKER_SECRETS alone).
 */
export async function keepAdoptedDeployment(
  env: NodeJS.ProcessEnv,
  access: CloudflareAccess & { worker: string; root: string }
): Promise<void> {
  const checkedIn = (
    TOML.parse(readFileSync(join(access.root, 'apps/api/wrangler.toml'), 'utf8')) as {
      vars?: Record<string, unknown>;
    }
  ).vars;
  carryDeployedVars(env, await deployedWorkerOverrideVars(access), {
    checkedIn: checkedIn ?? {},
    code: OMITTED_WORKER_VAR_DEFAULTS,
  });
  env.PRESERVE_EXISTING_WORKER_SECRETS = (await existingPreservedKeySecrets(access)).join(',');
}
