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
 * The one in-place update a takeover may perform. A routine deploy of an unchanged SAM updates
 * the Pages project, because the provider tracks its deployment records and each web deploy
 * replaces them: production deploy run 45661601817 shows `canonicalDeployment` and
 * `latestDeployment` as the properties that differ. Refusing that would refuse every takeover.
 * An update of the Pages project that names any other property, such as `productionBranch` (a
 * stack option this job cannot see), is a real reconfiguration and is refused, as is an in-place
 * update of anything else (a database, bucket, lifecycle rule, DNS record, route, key or
 * certificate).
 */
const PAGES_PROJECT_TYPE = 'cloudflare:index/pagesProject:PagesProject';
const PAGES_DEPLOYMENT_RECORDS = new Set(['canonicalDeployment', 'latestDeployment']);
const MAX_CHANGED_PROPERTIES = 6;

/** The top-level properties a step's detailed diff names; undefined when it reports none. */
function changedProperties(step: unknown): string[] | undefined {
  const diff = (step as { detailedDiff?: unknown } | null)?.detailedDiff;
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return undefined;
  const roots = new Set(Object.keys(diff).map((path) => path.split(/[.[]/, 1)[0] ?? path));
  return roots.size ? [...roots].sort((a, b) => a.localeCompare(b)) : undefined;
}

/** Whether an update only replaces the Pages project's deployment records. */
function isRoutinePagesUpdate(urn: unknown, changed: string[] | undefined): boolean {
  return (
    urnParts(urn)?.type === PAGES_PROJECT_TYPE &&
    changed !== undefined &&
    changed.every((property) => PAGES_DEPLOYMENT_RECORDS.has(property))
  );
}
const MAX_REFUSAL_LINES = 30;

/**
 * Worker secrets a deployment may have set as a GitHub-secret override that configure-secrets.sh
 * would otherwise rewrite from its default. An adopted installation has no GitHub secrets, so an
 * existing Worker secret with one of these names is kept, on the takeover and every later update.
 * Installation keys are not listed: no deploy writes them at all (scripts/deploy/installation-keys.ts).
 */
export const PRESERVED_KEY_SECRETS = ['VAPID_SUBJECT'] as const;
const MAX_REFUSAL_LINE_CHARS = 300;

/** Worker vars the engine computes for every deploy; a deployed value must never replace them. */
const ENGINE_OWNED_VARS = new Set(['VM_AGENT_REQUIRED_VERSION']);

/**
 * Settings `sync-wrangler-config.ts` takes from the deploy environment that are not in the
 * override-name list but do reach the Worker as plain-text vars, so the deployed Worker still
 * says what they were. The key is the Worker var; the value is the environment name that
 * produces it (`DEPLOY_BUILDER_CLASS_MAX_INSTANCES` is written from `DEPLOY_BUILDER_MAX_INSTANCES`).
 * The other container limits and the builder's instance type reach only the container
 * configuration and cannot be read back here (idea 01M8C88CXH9YTBZ4X3TDN1GP7J).
 */
const READABLE_SYNC_SETTINGS: Readonly<Record<string, string>> = {
  PREVIEW_BASE_DOMAIN: 'PREVIEW_BASE_DOMAIN',
  PREVIEW_URL_TTL_SECONDS: 'PREVIEW_URL_TTL_SECONDS',
  DEPLOY_BUILDER_CLASS_MAX_INSTANCES: 'DEPLOY_BUILDER_MAX_INSTANCES',
};

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
    const line = refusedTakeoverStep(step);
    if (line) refused.push(line);
  }
  return refused;
}

/** The refusal line for one preview step, or undefined when a takeover may perform it. */
function refusedTakeoverStep(step: unknown): string | undefined {
  const op = (step as { op?: unknown } | null)?.op;
  if (typeof op !== 'string') throw new Error('Invalid infrastructure preview');
  if (TAKEOVER_UNCHANGING_OPERATIONS.has(op)) return undefined;
  const urn = (step as { urn?: unknown }).urn;
  if (op !== 'update') return `${op} ${urnLabel(urn)}`;
  const changed = changedProperties(step);
  if (isRoutinePagesUpdate(urn, changed)) return undefined;
  return `${op} ${urnLabel(urn)}${changedSuffix(changed)}`;
}

/** The properties an update would change, by name only: the diff's values can be resource state. */
function changedSuffix(changed: string[] | undefined): string {
  if (!changed) return '';
  const shown = changed.slice(0, MAX_CHANGED_PROPERTIES).join(', ');
  return ` (changes: ${shown}${changed.length > MAX_CHANGED_PROPERTIES ? ', …' : ''})`;
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
  const names = new Set(WORKER_VAR_OVERRIDE_NAMES.filter((name) => !ENGINE_OWNED_VARS.has(name)));
  const vars: Record<string, string> = {};
  for (const [name, text] of await deployedPlainTextVars(access)) {
    if (names.has(name)) vars[name] = text;
    const setting = Object.hasOwn(READABLE_SYNC_SETTINGS, name)
      ? READABLE_SYNC_SETTINGS[name]
      : undefined;
    if (setting) vars[setting] = text;
  }
  return vars;
}

type WorkerBinding = { type?: unknown; name?: unknown; text?: unknown };

/** The deployed API Worker's bindings. A secret appears by name only, never with its value. */
async function deployedBindings(
  access: CloudflareAccess & { worker: string }
): Promise<WorkerBinding[]> {
  const settings = await cloudflareResult(access, `workers/scripts/${access.worker}/settings`);
  if (!settings.found) throw new Error('Adopted API Worker not found');
  const bindings = (settings.result as { bindings?: unknown } | undefined)?.bindings;
  if (!Array.isArray(bindings)) throw new Error('Invalid Worker settings');
  return bindings as WorkerBinding[];
}

/**
 * Whether the deployed API Worker sends email (the `AGENT_EMAIL` binding sync-wrangler-config.ts
 * emits once Email Sending is prepared). An adopted deploy prepares email only when this holds,
 * and then only from what already exists (`AGENT_EMAIL_EXISTING_ONLY`), because onboarding a
 * sending subdomain and writing its DNS records happen outside the takeover's no-change checks.
 * Matched by name alone: a miss would take a working binding away, which is the worse error.
 * Known limit, tracked in idea 01M8C88CXH9YTBZ4X3TDN1GP7J: an adopted installation that has no
 * email cannot get it from the service until its owner can hand over that setting.
 */
export async function deployedAgentEmail(
  access: CloudflareAccess & { worker: string }
): Promise<boolean> {
  return (await deployedBindings(access)).some((binding) => binding?.name === 'AGENT_EMAIL');
}

/** Every plain-text var the deployed API Worker runs with. Secrets are never readable here. */
async function deployedPlainTextVars(
  access: CloudflareAccess & { worker: string }
): Promise<Array<[string, string]>> {
  const vars: Array<[string, string]> = [];
  for (const binding of await deployedBindings(access)) {
    if (
      binding?.type === 'plain_text' &&
      typeof binding.name === 'string' &&
      typeof binding.text === 'string'
    )
      vars.push([binding.name, binding.text]);
  }
  return vars;
}

/**
 * Takeover step 1a, before the deployment is read or anything changes. `pulumi stack` opens the
 * state's secrets, so it fails at once on a wrong passphrase, and it neither runs the program
 * nor calls a provider. `pulumi stack output` cannot stand in: it never decrypts and succeeds
 * with any passphrase (both measured offline on Pulumi 3.278). A wrong passphrase can change
 * nothing either way, since preview, refresh and up all refuse it; without this check it would
 * surface only at the first preview, as an unexplained preview failure. The command's output
 * lists the stack's resources, so none of it is reported.
 */
export async function refuseUnopenableState(openState: () => Promise<unknown>): Promise<void> {
  try {
    await openState();
  } catch (error) {
    if (!(error instanceof EngineCommandFailure)) throw error;
    throw new AdoptionRefused([
      "The deploy state of this SAM could not be opened with the passphrase you entered, so nothing was changed. This is what a wrong passphrase looks like. Start the takeover again from the installer with the deployment's PULUMI_CONFIG_PASSPHRASE.",
    ]);
  }
}

/**
 * Takeover step 1b, before anything changes. `SETUP_FORCE=true` reopens the deployment's setup
 * page so a locked-out owner can recover (`isSetupCompleted`, platform-config-core.ts). A
 * takeover deploys without it, which would close setup under someone in the middle of a
 * recovery; carrying it instead would leave an emergency switch on for good, with no GitHub
 * variable left to turn it off. So the takeover refuses until the owner has finished and
 * removed it.
 */
export async function refuseForcedSetup(
  access: CloudflareAccess & { worker: string }
): Promise<void> {
  const vars = await deployedPlainTextVars(access);
  if (vars.some(([name, text]) => name === 'SETUP_FORCE' && text === 'true'))
    throw new AdoptionRefused([
      'This SAM has forced setup switched on (SETUP_FORCE=true), which reopens its setup page for account recovery. A takeover would switch it off. Finish the recovery and remove SETUP_FORCE from the deployment, then take over.',
    ]);
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
  const rows = await databaseRows(access, 'SELECT name FROM d1_migrations ORDER BY id');
  return (rows as Array<{ name?: unknown }>)
    .map((row) => row?.name)
    .filter((name): name is string => typeof name === 'string' && !local.has(name));
}

/** The rows of one read-only statement against a deployed D1 database. */
async function databaseRows(
  access: CloudflareAccess & { databaseId: string },
  sql: string
): Promise<unknown[]> {
  const query = await cloudflareResult(access, `d1/database/${access.databaseId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  if (!query.found) throw new Error('Adopted database not found');
  const rows = Array.isArray(query.result)
    ? (query.result[0] as { results?: unknown } | undefined)?.results
    : undefined;
  if (!Array.isArray(rows)) throw new Error('Invalid database query result');
  return rows;
}

/** `SYSTEM_USER_ID` in packages/shared/src/system-ids.ts: a sentinel row, never an owner. */
const SYSTEM_USER_ID = 'system_anonymous_trials';

/**
 * A takeover binds no owner and hands over no setup token, so the deployment must already have
 * one: an active superadmin, the same test that closes first-run setup (`isSetupCompleted`,
 * platform-config-core.ts). Without one its setup page is still open behind a token this deploy
 * regenerates, and the installation service would tell the owner there is nothing to set up.
 */
async function refuseWithoutOwner(
  access: CloudflareAccess & { databaseId: string }
): Promise<void> {
  const rows = await databaseRows(
    access,
    `SELECT COUNT(*) AS owners FROM users WHERE role = 'superadmin' AND status = 'active' AND id != '${SYSTEM_USER_ID}'`
  );
  const owners = (rows[0] as { owners?: unknown } | undefined)?.owners;
  if (typeof owners !== 'number') throw new Error('Invalid database query result');
  if (owners === 0)
    throw new AdoptionRefused([
      'This SAM has no active administrator, so its first-run setup is not finished. A takeover binds no owner and hands over no setup token. Finish setup on the existing deployment first, or install a new SAM instead.',
    ]);
}

/**
 * Takeover step 1, before anything changes: the deployment must have an owner, and no deployed
 * database may be newer than the approved source, or this deploy would run older code on a newer
 * schema.
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
    // The primary database holds the users.
    if (ledger.required) await refuseWithoutOwner({ ...access, databaseId });
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
