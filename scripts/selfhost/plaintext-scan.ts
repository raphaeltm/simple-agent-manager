/**
 * `pnpm selfhost:secrets plaintext [--backups DIR] [--purge --confirm <CELLD_BUCKET>]`
 *
 * Before sealed secrets, every deploy passed the Worker secrets as vars, and celld keeps each
 * deployed version's config, vars included, under `deploy/<script>/<version>/manifest.json` in
 * the fleet bucket. This lists those versions and the backups that still hold plaintext, says
 * which secrets to rotate and how, and (opt-in) deletes the versions celld no longer reads.
 *
 * What celld still needs (celld v0.6.3 source, read 2026-11-12): a node loads the deployment that
 * `deploy/current.json` names (fleet.rs load_current_worker), service bindings through
 * `deploy/<script>/current.json` (load_named_worker), and a queue consumer at the exact prefix
 * its attachment `deploy/queues/<queue>/consumer.json` names (load_queue_consumer_worker). A
 * running node holds its booted version in memory. celld itself never deletes or lists old
 * versions. So a version named by no pointer and no attachment is never read again.
 *
 * But celld's documentation (docs/guarantees.md) says an operator must not delete objects under
 * `deploy/`, with no exception for old versions. The purge therefore: runs only on the pinned
 * celld version this analysis was made for; deletes only versions that hold plaintext secrets and
 * that no pointer or attachment names, re-read just before each deletion; refuses while the
 * current version itself still holds plaintext; and needs `--confirm <bucket url>`. The safest
 * course needs no deletion at all: rotate every secret the listing names, which makes the old
 * copies worthless.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { SIGNING_KEY_NAME } from '../../deploy/selfhost/key-agent/server.ts';
import { type BoxContext, readManifest } from './backup-lib';
import { deleteObjects, listObjects, readObject } from './bucket-objects';
import { applyKeyChoice, explicitKeyProvider, readKeyChoice } from './key-choice';
import { KEY_AGENT_DIR, keyServiceSettings, listBundles } from './key-service';
import { PLATFORM_KEY_NAMES } from './platform-keys';
import { parseDotenv, readPrivateJson } from './secret-files';
import { CELLD_VERSION } from './versions';

/** The celld release whose bucket readers the purge rule above was derived from. */
export const PURGE_VERIFIED_CELLD_VERSION = '0.6.3';
/** Values shorter than this are not matched by content (too many false hits); names still are. */
const MIN_MATCH_LENGTH = 12;
const NOT_SECRET = new Set(['SAM_INSTALLATION_ID']);

export interface KnownSecrets {
  names: Set<string>;
  /** Kept in memory only, for matching; never printed. */
  values: string[];
}

/** The Worker's secrets as this box knows them: the newest bundle and any plaintext files left. */
export async function knownSecrets(
  box: Readonly<Record<string, string>>,
  stateDir: string
): Promise<KnownSecrets> {
  const all: Record<string, string> = {};
  const keysFile = join(stateDir, 'platform-keys.json');
  if (existsSync(keysFile)) {
    Object.assign(all, readPrivateJson(keysFile));
  }
  const secretsFile = join(stateDir, 'secrets.env');
  if (existsSync(secretsFile))
    Object.assign(all, parseDotenv(readFileSync(secretsFile, 'utf8'), secretsFile));
  const newest = listBundles(join(stateDir, KEY_AGENT_DIR, 'bundles'), () => undefined)[0];
  if (newest) {
    const choice = readKeyChoice(stateDir);
    const effective = !explicitKeyProvider(box) && choice ? applyKeyChoice(box, choice) : box;
    const settings = keyServiceSettings(effective, stateDir);
    if (settings) Object.assign(all, await openBundle(newest, createKeyProvider(settings.hostEnv)));
  }
  const names = new Set<string>(PLATFORM_KEY_NAMES.filter((n) => !NOT_SECRET.has(n)));
  const values: string[] = [];
  for (const [name, value] of Object.entries(all)) {
    if (NOT_SECRET.has(name) || name === SIGNING_KEY_NAME) continue;
    names.add(name);
    if (value.length >= MIN_MATCH_LENGTH) values.push(value);
  }
  return { names, values };
}

export interface DeployVersion {
  prefix: string;
  script: string;
  keys: string[];
  lastModified: string;
  /** Secret names among the version's plain-text vars (names only). */
  secretNames: string[];
  /** Pointer or attachment keys that name this version; empty means celld no longer reads it. */
  referencedBy: string[];
}

const VERSION_KEY = /^deploy\/([^/]+)\/([^/]+)\/(.+)$/;
const RESERVED_SCRIPTS = new Set(['queues', 'images']);

/** Plain-text vars of a manifest: celld keeps them as `raw_metadata.bindings` of type plain_text. */
export function manifestVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const parsed = JSON.parse(text) as unknown;
  const meta = (parsed as { raw_metadata?: unknown } | null)?.raw_metadata;
  if (typeof meta !== 'object' || meta === null) return vars;
  const record = meta as Record<string, unknown>;
  if (Array.isArray(record.bindings)) {
    for (const binding of record.bindings as unknown[]) {
      const b = binding as Record<string, unknown> | null;
      if (b?.type === 'plain_text' && typeof b.name === 'string' && typeof b.text === 'string') {
        vars[b.name] = b.text;
      }
    }
  }
  if (typeof record.vars === 'object' && record.vars !== null) {
    for (const [name, value] of Object.entries(record.vars as Record<string, unknown>)) {
      if (typeof value === 'string') vars[name] = value;
    }
  }
  return vars;
}

function secretsIn(text: string, secrets: KnownSecrets): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(manifestVars(text))) {
    if (secrets.names.has(name) && value !== '') found.add(name);
  }
  if (secrets.values.some((value) => text.includes(value))) found.add('(a known secret value)');
  return [...found].sort();
}

/** Every version prefix that a pointer or queue attachment names, with who names it. */
export function referencedPrefixes(
  ctx: BoxContext,
  keys: readonly string[]
): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const holders = keys.filter(
    (key) =>
      key === 'deploy/current.json' ||
      /^deploy\/[^/]+\/current\.json$/.test(key) ||
      /^deploy\/queues\/[^/]+\/consumer\.json$/.test(key)
  );
  for (const key of holders) {
    // Every string in the file that looks like a version prefix counts: a reference is a reference.
    for (const match of readObject(ctx, key).matchAll(/"(deploy\/[^"/]+\/[^"/]+)\/?"/g)) {
      const prefix = match[1] ?? '';
      refs.set(prefix, [...(refs.get(prefix) ?? []), key]);
    }
  }
  return refs;
}

export function scanDeployVersions(ctx: BoxContext, secrets: KnownSecrets): DeployVersion[] {
  const objects = listObjects(ctx, 'deploy/');
  const keys = objects.map((o) => o.key);
  const refs = referencedPrefixes(ctx, keys);
  const versions = new Map<string, DeployVersion>();
  for (const object of objects) {
    const match = VERSION_KEY.exec(object.key);
    if (!match || RESERVED_SCRIPTS.has(match[1] ?? '') || match[2] === 'current.json') continue;
    const prefix = `deploy/${match[1]}/${match[2]}`;
    const version =
      versions.get(prefix) ??
      ({
        prefix,
        script: match[1] ?? '',
        keys: [],
        lastModified: '',
        secretNames: [],
        referencedBy: refs.get(prefix) ?? [],
      } satisfies DeployVersion);
    version.keys.push(object.key);
    if (object.lastModified > version.lastModified) version.lastModified = object.lastModified;
    versions.set(prefix, version);
  }
  for (const version of versions.values()) {
    const manifest = `${version.prefix}/manifest.json`;
    if (version.keys.includes(manifest))
      version.secretNames = secretsIn(readObject(ctx, manifest), secrets);
  }
  return [...versions.values()].sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
}

export interface BackupFinding {
  dir: string;
  createdAt: string;
  holds: string[];
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]
  );
}

/** Local backups (backup-lib.ts layout) and what plaintext each holds. */
export function scanBackups(root: string, secrets: KnownSecrets): BackupFinding[] {
  if (!existsSync(root)) return [];
  const findings: BackupFinding[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    const manifestPath = join(dir, 'backup-manifest.json');
    if (!existsSync(manifestPath)) continue;
    let createdAt = '';
    try {
      createdAt = readManifest(dir).createdAt;
    } catch {
      createdAt = '(unreadable manifest)';
    }
    const holds: string[] = [];
    for (const file of ['platform-keys.json', 'secrets.env']) {
      if (existsSync(join(dir, 'state', file))) holds.push(`state/${file}`);
    }
    if (existsSync(join(dir, 'state', KEY_AGENT_DIR, 'kek')))
      holds.push('the file key (state/key-agent/kek)');
    const exposed = new Set<string>();
    for (const file of filesUnder(join(dir, 'bucket', 'deploy'))) {
      if (!file.endsWith('/manifest.json')) continue;
      for (const n of secretsIn(readFileSync(join(dir, 'bucket', 'deploy', file), 'utf8'), secrets))
        exposed.add(n);
    }
    if (exposed.size > 0) holds.push(`bucket deploy versions with ${[...exposed].join(', ')}`);
    if (existsSync(join(dir, 'env'))) holds.push('env (the bucket credential, in every backup)');
    findings.push({ dir, createdAt, holds });
  }
  return findings;
}

/**
 * Backups kept in another bucket (gs:// or s3://, read with the box's own credentials): grouped by
 * the first path segment under the URL. Deploy manifests are read and checked; plaintext state
 * files are named; archives (`.tgz`, `.tar*`) are reported as unopened.
 */
export function scanRemoteBackups(
  ctx: BoxContext,
  url: string,
  secrets: KnownSecrets
): BackupFinding[] {
  const remote: BoxContext = { ...ctx, box: { ...ctx.box, CELLD_BUCKET: url } };
  const groups = new Map<string, { latest: string; holds: Set<string>; exposed: Set<string> }>();
  for (const object of listObjects(remote, '')) {
    const [top = '', ...rest] = object.key.split('/');
    const group = rest.length > 0 ? top : '(top level)';
    const entry = groups.get(group) ?? {
      latest: '',
      holds: new Set<string>(),
      exposed: new Set<string>(),
    };
    if (object.lastModified > entry.latest) entry.latest = object.lastModified;
    const name = object.key.split('/').pop() ?? '';
    if (/(^|\/)deploy\/[^/]+\/[^/]+\/manifest\.json$/.test(object.key)) {
      for (const n of secretsIn(readObject(remote, object.key), secrets)) entry.exposed.add(n);
    } else if (name === 'platform-keys.json' || name === 'secrets.env' || name === 'kek') {
      entry.holds.add(name);
    } else if (/\.(tgz|tar|tar\.gz|tar\.zst)$/.test(name)) {
      entry.holds.add(
        `archive ${name} (not opened; a .state archive holds plaintext keys if taken before sealing)`
      );
    }
    groups.set(group, entry);
  }
  return [...groups.entries()].sort().map(([group, entry]) => ({
    dir: `${url.replace(/\/+$/, '')}/${group}`,
    createdAt: entry.latest,
    holds: [
      ...[...entry.holds].sort(),
      ...(entry.exposed.size > 0
        ? [`deploy versions with ${[...entry.exposed].sort().join(', ')}`]
        : []),
    ],
  }));
}

/** How to rotate each kind of secret the listing names. */
export function rotationAdvice(name: string): string {
  if (name === 'ENCRYPTION_KEY' || name.startsWith('ENCRYPTION_KEY_')) {
    return 'cannot be rotated by a SAM command yet (stored credentials are encrypted under it). Treat the credentials users stored in SAM as exposed: have them replace cloud tokens and agent keys.';
  }
  if (PLATFORM_KEY_NAMES.includes(name as (typeof PLATFORM_KEY_NAMES)[number])) {
    return 'a generated platform key; no SAM rotation command yet. Exposure lets someone sign tokens or push messages as this install until it is replaced.';
  }
  if (name.startsWith('GITHUB_')) {
    return 'regenerate it in the GitHub App settings (client secret, private key or webhook secret), put the new value in .state/secrets.env, run pnpm selfhost:deploy, then delete the old one at GitHub.';
  }
  if (name.includes('SMTP'))
    return 'change the password at your mail relay, put it in .state/secrets.env, deploy.';
  if (name.startsWith('R2_') || name.startsWith('AWS_')) {
    return 'create a new scoped bucket credential, put it in .state/secrets.env, deploy, then revoke the old one.';
  }
  return 'issue a new value where it comes from, put it in .state/secrets.env, deploy, then revoke the old one.';
}

export interface PurgeResult {
  deleted: string[];
  skipped: string[];
}

/** Deletes old versions that hold plaintext and that nothing references (module comment). */
export function purgeVersions(
  ctx: BoxContext,
  secrets: KnownSecrets,
  confirm: string | undefined
): PurgeResult {
  if (confirm !== ctx.box.CELLD_BUCKET) {
    throw new Error(
      `--purge needs --confirm ${ctx.box.CELLD_BUCKET} (the CELLD_BUCKET it deletes from)`
    );
  }
  if (CELLD_VERSION !== PURGE_VERIFIED_CELLD_VERSION) {
    throw new Error(
      `the purge rule was verified against celld ${PURGE_VERIFIED_CELLD_VERSION}; this box pins ${CELLD_VERSION}. Re-check celld's readers of deploy/ before purging`
    );
  }
  const versions = scanDeployVersions(ctx, secrets);
  const current = versions.find((v) => v.referencedBy.includes('deploy/current.json'));
  if (!current)
    throw new Error('deploy/current.json names no version in this bucket; refusing to purge');
  if (current.secretNames.length > 0) {
    throw new Error(
      'the current deploy version still holds plaintext secrets: run the sealed deploy (pnpm selfhost:secrets migrate) first'
    );
  }
  const result: PurgeResult = { deleted: [], skipped: [] };
  for (const version of versions) {
    if (version.secretNames.length === 0) continue;
    // Re-read every pointer and attachment right before deleting: a deploy may have moved one.
    const fresh = referencedPrefixes(
      ctx,
      listObjects(ctx, 'deploy/').map((o) => o.key)
    );
    if (version.referencedBy.length > 0 || fresh.has(version.prefix)) {
      result.skipped.push(`${version.prefix} (still referenced)`);
      continue;
    }
    deleteObjects(ctx, version.keys);
    result.deleted.push(version.prefix);
  }
  return result;
}

/** The listing as printed by `pnpm selfhost:secrets plaintext`: names, paths and dates only. */
export function formatPlaintextReport(
  bucket: string,
  versions: readonly DeployVersion[],
  backups: readonly BackupFinding[],
  backupsRoot: string
): string[] {
  const lines: string[] = [];
  const exposedNames = new Set<string>();
  const dirty = versions.filter((v) => v.secretNames.length > 0);
  lines.push(
    `fleet bucket ${bucket}: ${versions.length} deploy version(s), ${dirty.length} with plaintext secrets`
  );
  for (const v of versions) {
    for (const n of v.secretNames) exposedNames.add(n);
    const state =
      v.referencedBy.length > 0
        ? `in use (${v.referencedBy.join(', ')})`
        : v.secretNames.length > 0
          ? 'not read by celld; purgeable'
          : 'not read by celld; clean';
    const holds = v.secretNames.length > 0 ? `holds ${v.secretNames.join(', ')}` : 'no secrets';
    lines.push(`  ${v.prefix}  ${v.lastModified}  ${state}; ${holds}`);
  }
  lines.push(`backups under ${backupsRoot}: ${backups.length}`);
  for (const b of backups) {
    lines.push(
      `  ${b.dir}  ${b.createdAt}  ${b.holds.length > 0 ? b.holds.join('; ') : 'nothing in plaintext found'}`
    );
  }
  lines.push(
    'Backups copied anywhere else (another bucket, a laptop) are not visible here: treat every ' +
      'backup taken before this box was sealed as holding every secret in plaintext.'
  );
  if (exposedNames.size > 0) {
    lines.push('Rotate what these copies hold (deleting a copy does not undo an earlier read):');
    for (const name of [...exposedNames].sort()) lines.push(`  ${name}: ${rotationAdvice(name)}`);
  }
  if (dirty.some((v) => v.referencedBy.length === 0)) {
    lines.push(
      `To delete the purgeable versions: pnpm selfhost:secrets plaintext --purge --confirm ${bucket}` +
        ' (read the README first: celld documents deploy/ as not to be deleted by operators)'
    );
  }
  return lines;
}
