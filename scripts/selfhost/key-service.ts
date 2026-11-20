/**
 * Sealed Worker secrets for a celld box: the default. `SAM_KEY_PROVIDER` in `.env` overrides the
 * provider `--init` chose (key-choice.ts); `legacy-plaintext` keeps the old behaviour.
 *
 * Legacy: the deploy passes every secret as a Worker var, and celld stores each deployed
 * version's vars in plaintext in the fleet bucket. Sealed: the deploy seals the secrets into a
 * bundle under `<state>/key-agent/bundles/`, passes only the bundle id and the agent's loopback
 * URL as vars, and the API Worker fetches the secrets at runtime from the `key-agent` compose
 * service (deploy/selfhost/key-agent), which alone can open the bundle with the key service.
 *
 * The deploy calls the provider itself (it runs on the box as the operator, with the same
 * credential the agent uses). It never needs the agent to be up to seal.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  openBundle,
  parseBundle,
  type SealedBundle,
  sealSecrets,
  type Secrets,
} from '../../deploy/selfhost/key-agent/bundle.ts';
import {
  type BundleStore,
  LOCAL_BUNDLE_SUBDIR,
  openBundleStore,
} from '../../deploy/selfhost/key-agent/bundle-store.ts';
import { pingKeyAgent } from '../../deploy/selfhost/key-agent/healthcheck.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { generateFileKek } from '../../deploy/selfhost/key-agent/provider-file.ts';
import {
  createKeyProvider,
  KEY_PROVIDERS,
  LEGACY_KEY_PROVIDER,
} from '../../deploy/selfhost/key-agent/providers.ts';
import { SIGNING_KEY_NAME } from '../../deploy/selfhost/key-agent/server.ts';
import {
  assertSecretsKeepPlatformKeys,
  completeSealedPlatformKeys,
  ensurePlatformKeys,
  PLATFORM_KEY_NAMES,
  PLATFORM_KEYS_FILE,
  type PlatformKeysMode,
} from './platform-keys.js';
import {
  ensurePrivateDir,
  readPrivateJson,
  readSecretsFile,
  writePrivateFile,
} from './secret-files.js';
import { keyFileNotice } from './secrets-keyfile.js';

export { LEGACY_KEY_PROVIDER };
export const KEY_AGENT_DIR = 'key-agent';
/**
 * The clone identity a restore of a sealed backup records (restore-identity.ts), sealed in by the
 * target's `pnpm selfhost:deploy --init` (readRestoredIdentity below), which holds the key.
 */
export const RESTORED_IDENTITY_FILE = join(KEY_AGENT_DIR, 'restored-identity.json');
export const DEFAULT_KEY_AGENT_PORT = 7190;
/** Bundles kept after a seal: the Worker version still running during a deploy asks for its own. */
export const DEFAULT_KEPT_BUNDLES = 3;
/** Where the compose service mounts `<state>/key-agent` (docker-compose.yml). */
const CONTAINER_DIR = '/etc/sam/key-agent';
/** Credential files a provider may read, relative to `<state>/key-agent/credentials/`. */
const CREDENTIAL_FILES: Readonly<Record<string, string>> = {
  SAM_TRANSIT_TOKEN_FILE: 'transit-token',
  SAM_TRANSIT_SECRET_ID_FILE: 'transit-secret-id',
  SAM_AWS_CREDENTIALS_FILE: 'aws-credentials',
};
/** Non-secret provider settings copied from `.env` into the agent's environment. */
const PROVIDER_SETTINGS = [
  'SAM_TRANSIT_ADDR',
  'SAM_TRANSIT_MOUNT',
  'SAM_TRANSIT_KEY',
  'SAM_TRANSIT_NAMESPACE',
  'SAM_TRANSIT_ROLE_ID',
  'SAM_GCP_KMS_KEY',
  'SAM_GCP_KMS_ENDPOINT',
  'SAM_GCE_METADATA_HOST',
  'SAM_AZURE_KEY_VAULT_URL',
  'SAM_AZURE_KEY_NAME',
  'SAM_AZURE_CLIENT_ID',
  'SAM_AZURE_IMDS_HOST',
  'SAM_AWS_KMS_KEY_ID',
  'SAM_AWS_KMS_REGION',
  'SAM_AWS_KMS_ENDPOINT',
  'SAM_AWS_IMDS_HOST',
] as const;
/** Box files that can unlock the bundle; backups leave them out (backup-lib.ts). */
export const KEY_SERVICE_BACKUP_EXCLUDES = [`${KEY_AGENT_DIR}/kek`, `${KEY_AGENT_DIR}/credentials`];

type Box = Readonly<Record<string, string | undefined>>;

export interface KeyServiceSettings {
  provider: string;
  port: number;
  dir: string;
  /** Where the bundles live (deploy/selfhost/key-agent/bundle-store.ts, the one seam). */
  bundles: BundleStore;
  /** The provider's environment as seen from the box (host paths). */
  hostEnv: Record<string, string>;
  /** The same environment as seen from the key-agent container. */
  containerEnv: Record<string, string>;
}

/** Whether this box seals its secrets. `box` is the effective box (key-choice.ts applyKeyChoice). */
export function keyServiceEnabled(box: Box): boolean {
  const value = box.SAM_KEY_PROVIDER?.trim() ?? '';
  return value !== '' && value !== LEGACY_KEY_PROVIDER;
}

export function keyAgentPort(box: Box): number {
  const raw = box.SAM_KEY_AGENT_PORT?.trim();
  if (!raw) return DEFAULT_KEY_AGENT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('SAM_KEY_AGENT_PORT must be an integer between 1024 and 65535');
  }
  return port;
}

export function keyServiceSettings(box: Box, stateDir: string): KeyServiceSettings | null {
  if (!keyServiceEnabled(box)) return null;
  const provider = (box.SAM_KEY_PROVIDER ?? '').trim();
  if (!Object.hasOwn(KEY_PROVIDERS, provider)) {
    throw new Error(
      `SAM_KEY_PROVIDER must be empty (automatic), ${LEGACY_KEY_PROVIDER}, or one of ` +
        Object.keys(KEY_PROVIDERS).join(', ')
    );
  }
  const dir = join(stateDir, KEY_AGENT_DIR);
  const hostEnv: Record<string, string> = { SAM_KEY_PROVIDER: provider };
  const containerEnv: Record<string, string> = { SAM_KEY_PROVIDER: provider };
  for (const name of PROVIDER_SETTINGS) {
    const value = box[name]?.trim();
    if (value) {
      hostEnv[name] = value;
      containerEnv[name] = value;
    }
  }
  // Test-only switch (plain-HTTP fake Key Vault): honoured by the deploy, never given to the agent.
  if (box.SAM_AZURE_ALLOW_HTTP_FOR_TESTS === '1') hostEnv.SAM_AZURE_ALLOW_HTTP_FOR_TESTS = '1';
  if (provider === 'file') {
    hostEnv.SAM_KEY_FILE = join(dir, 'kek');
    containerEnv.SAM_KEY_FILE = `${CONTAINER_DIR}/kek`;
  }
  for (const [name, file] of Object.entries(CREDENTIAL_FILES)) {
    if (existsSync(join(dir, 'credentials', file))) {
      hostEnv[name] = join(dir, 'credentials', file);
      containerEnv[name] = `${CONTAINER_DIR}/credentials/${file}`;
    }
  }
  return {
    provider,
    port: keyAgentPort(box),
    dir,
    bundles: bundleStoreFor(stateDir),
    hostEnv,
    containerEnv,
  };
}

/** This box's bundles (deploy/selfhost/key-agent/bundle-store.ts). */
export function bundleStoreFor(stateDir: string): BundleStore {
  return openBundleStore({ dir: join(stateDir, LOCAL_BUNDLE_SUBDIR) });
}

/**
 * The uid the key-agent container runs as (docker-compose.yml `user:`): it must own `.state`,
 * because the bundles and the key file are this user's mode-0600 files, and it must not be root
 * (finding F10: the agent no longer starts as root and drops privileges). The deploy runs as the
 * state owner, so its own uid is the only right value. Docker Compose reads it from `.env`; the
 * deploy never edits `.env`, so `--init` prints the line and every sealing deploy checks it.
 */
export function assertKeyAgentUid(box: Box, stateDir: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  if (uid === 0) {
    throw new Error(
      `sealed secrets: run the deploy as the user that owns ${stateDir}, not root (the key agent ` +
        'runs as that user and refuses root)'
    );
  }
  const pinned = box.SAM_KEY_AGENT_UID?.trim();
  if (pinned !== String(uid)) {
    throw new Error(
      `${keyAgentUidLine()} must be in .env (found ${pinned ? `SAM_KEY_AGENT_UID=${pinned}` : 'none'}): ` +
        `the key-agent container runs as the owner of ${stateDir}, never as root. Add the line, ` +
        'then run docker compose up -d before deploying.'
    );
  }
}

/** The `.env` line the key-agent container needs on this box. */
export function keyAgentUidLine(): string {
  return `SAM_KEY_AGENT_UID=${process.getuid?.() ?? ''}`;
}

/** The Worker's view of the agent: a loopback socket only celld's uid may use. */
export function keyAgentAddress(settings: Pick<KeyServiceSettings, 'port'>): string {
  return `127.0.0.1:${settings.port}`;
}

/** The agent's env_file (non-secret: provider name, key reference, credential file paths). */
export function renderKeyAgentEnv(settings: KeyServiceSettings): string {
  const lines = Object.entries({
    ...settings.containerEnv,
    SAM_KEY_AGENT_PORT: String(settings.port),
    SAM_KEY_AGENT_BUNDLE_DIR: `${CONTAINER_DIR}/bundles`,
  }).map(([name, value]) => `${name}=${value}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The agent's env_file on a legacy box. The service always runs (docker-compose.yml); with this
 * it answers health checks and refuses every secrets request, and the fence gives celld no way
 * to reach it anyway (egress-fence.ts opens its port only when sealing is on).
 */
export function ensureLegacyAgentEnv(stateDir: string, port: number): string[] {
  const dir = join(stateDir, KEY_AGENT_DIR);
  ensurePrivateDir(dir);
  const envPath = join(dir, 'agent.env');
  const env = `SAM_KEY_PROVIDER=${LEGACY_KEY_PROVIDER}\nSAM_KEY_AGENT_PORT=${port}\n`;
  if (existsSync(envPath) && readFileSync(envPath, 'utf8') === env) return [];
  writePrivateFile(envPath, env);
  return [envPath];
}

/**
 * Creates the agent's directory and env file, and the file provider's KEK once: only while no
 * bundle exists. A missing key file beside existing bundles was lost, not never made, and a new
 * one could never open them, so that stops the deploy (restore the copy kept off the box).
 */
export async function ensureKeyServiceFiles(settings: KeyServiceSettings): Promise<string[]> {
  const written: string[] = [];
  ensurePrivateDir(settings.dir);
  const keyFile = settings.hostEnv.SAM_KEY_FILE ?? '';
  if (settings.provider === 'file' && !existsSync(keyFile)) {
    if ((await settings.bundles.listIds()).length > 0) {
      throw new Error(
        `${keyFile} is missing but ${settings.bundles.location} holds sealed bundles: the key ` +
          'file was lost. Restore it from the copy you kept off the box; a new key could not ' +
          'open them.'
      );
    }
    writePrivateFile(keyFile, `${generateFileKek()}\n`);
    written.push(keyFile);
  }
  const envPath = join(settings.dir, 'agent.env');
  const env = renderKeyAgentEnv(settings);
  if (!existsSync(envPath) || readFileSync(envPath, 'utf8') !== env) {
    writePrivateFile(envPath, env);
    written.push(envPath);
  }
  return written;
}

/** Bundles in the store, newest first; unreadable ones are reported and skipped. */
export async function listBundles(
  store: BundleStore,
  warn: (message: string) => void = console.warn
): Promise<SealedBundle[]> {
  const bundles: SealedBundle[] = [];
  for (const id of await store.listIds()) {
    try {
      const text = await store.read(id);
      if (text === null) continue;
      const bundle = parseBundle(text);
      if (bundle.bundleId !== id) throw new Error('bundle id does not match its name');
      bundles.push(bundle);
    } catch (error) {
      warn(
        `[selfhost] skipping bundle ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return bundles.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
}

export async function pruneBundles(
  store: BundleStore,
  keepIds: readonly string[]
): Promise<string[]> {
  const removed: string[] = [];
  for (const bundle of await listBundles(store)) {
    if (keepIds.includes(bundle.bundleId)) continue;
    await store.remove(bundle.bundleId);
    removed.push(bundle.bundleId);
  }
  return removed;
}

function sameSecrets(a: Secrets, b: Secrets): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  );
}

export interface ResolveSecretsInput {
  settings: KeyServiceSettings;
  /** The state dir (platform-keys.ts looks there for traces of an earlier deploy). */
  stateDir: string;
  /** What the deploy is doing (platform-keys.ts): only `init` creates keys; `dry-run` writes nothing. */
  mode: PlatformKeysMode;
  provider?: KeyProvider;
  /** `.state/platform-keys.json` when it still exists (an install migrating from plain files). */
  platformKeysFile: Record<string, string> | null;
  /** `.state/secrets.env`, merged last: the operator's edits win, except over a platform key. */
  operatorSecrets: Record<string, string>;
  /** Where operatorSecrets came from, for messages (default `secrets.env`). */
  secretsSource?: string;
  /**
   * Names to drop from the sealed secrets (`pnpm selfhost:deploy --unset NAME`). Bundles merge
   * secrets.env over the newest bundle, so deleting a line never removed a sealed value (box
   * round R16). See assertUnsettable for what may be removed.
   */
  unset?: readonly string[];
  keep?: number;
  log?: (message: string) => void;
}

export interface ResolvedSecrets {
  /** The bundle the Worker reads; for a dry run that would seal, a placeholder. */
  bundleId: string;
  secrets: Secrets;
  sealed: boolean;
  generated: string[];
}

/** Stands in for the id of a bundle a dry run would seal; never written anywhere. */
export const DRY_RUN_BUNDLE_ID = '0'.repeat(32);

/**
 * A sealed value the operator may remove: one of theirs, already deleted from secrets.env. SAM's
 * own keys are refused: removing one would make the next deploy generate a new one, which loses
 * every credential stored under ENCRYPTION_KEY or signs every session out (rotate them instead).
 */
export function assertUnsettable(name: string, operatorSecrets: Record<string, string>): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`--unset ${name}: not a secret name`);
  if ((PLATFORM_KEY_NAMES as readonly string[]).includes(name) || name === SIGNING_KEY_NAME) {
    throw new Error(
      `--unset ${name}: SAM generates this key and the install depends on it; it cannot be ` +
        'removed (removing it would make the next deploy generate a new one)'
    );
  }
  if (name in operatorSecrets) {
    throw new Error(
      `--unset ${name}: it is still in secrets.env, which wins over the sealed bundle. Delete ` +
        'its line first, then deploy with --unset again.'
    );
  }
}

/**
 * Checks `--unset` names against secrets.env without sealing anything, logging `say(name)` for
 * each: an unsealed box (nothing sealed to remove) and `deploy --dry-run` (applying it would seal
 * a bundle without the value and prune old bundles, security review).
 */
export function checkUnsetNames(
  names: readonly string[],
  secretsPath: string,
  log: (message: string) => void,
  say: (name: string) => string
): void {
  if (names.length === 0) return;
  const operatorSecrets = readSecretsFile(secretsPath);
  for (const name of names) {
    assertUnsettable(name, operatorSecrets);
    log(say(name));
  }
}

/**
 * The `--unset` names this deploy applies. Under `--dry-run` none: the names are only checked and
 * the removal is described, because applying it would seal (security review).
 */
export function unsetForThisRun(
  names: readonly string[] | undefined,
  dryRun: boolean | undefined,
  secretsPath: string,
  log: (message: string) => void
): readonly string[] {
  if (!dryRun) return names ?? [];
  checkUnsetNames(
    names ?? [],
    secretsPath,
    log,
    (name) => `dry run: would remove ${name} from the sealed secrets (run again without --dry-run)`
  );
  return [];
}

/**
 * The secrets this deploy runs with, and the bundle that holds them. Opens the newest bundle,
 * lays the plaintext migration files over it, completes the platform keys under the same rules as
 * platform-keys.json (platform-keys.ts completeSealedPlatformKeys: only `--init` generates, a lost
 * identity key is never regenerated), and seals a new bundle only when the result differs. A
 * platform key whose file value disagrees with the bundle stops the deploy: silently replacing
 * ENCRYPTION_KEY would make every stored credential undecryptable. A dry run seals nothing.
 */
export async function resolveSealedSecrets(input: ResolveSecretsInput): Promise<ResolvedSecrets> {
  const { settings } = input;
  const log = input.log ?? (() => undefined);
  // Created only when needed: a dry run on a fresh box has no key file to read yet.
  let created: KeyProvider | undefined = input.provider;
  const provider = (): KeyProvider => (created ??= createKeyProvider(settings.hostEnv));
  const latest = (await listBundles(settings.bundles))[0];
  const current = latest ? await openBundle(latest, provider()) : {};
  const restored = readRestoredIdentity(input.stateDir, latest, current);
  if (restored) current.SAM_INSTALLATION_ID = restored.installationId;
  const fromFile = input.platformKeysFile ?? {};
  for (const name of PLATFORM_KEY_NAMES) {
    const sealed = current[name];
    const plain = fromFile[name];
    if (sealed !== undefined && plain !== undefined && sealed !== plain) {
      throw new Error(
        `${name} in ${PLATFORM_KEYS_FILE} differs from the sealed bundle ${latest?.bundleId}; ` +
          'refusing to rotate a platform key. Remove the stale file or restore the matching one.'
      );
    }
  }
  const source = latest
    ? `the sealed bundle ${latest.bundleId}`
    : `${settings.bundles.location} (no sealed bundle yet) and ${PLATFORM_KEYS_FILE}`;
  const completed = completeSealedPlatformKeys(
    input.stateDir,
    { ...current, ...fromFile },
    source,
    input.mode
  );
  const generated: string[] = [...completed.generated];
  // secrets.env is laid over the keys below; it may not replace one (as on a legacy box).
  assertSecretsKeepPlatformKeys(
    input.operatorSecrets,
    completed.keys,
    input.secretsSource ?? 'secrets.env'
  );
  const secrets: Secrets = { ...current, ...completed.keys, ...input.operatorSecrets };
  for (const name of input.unset ?? []) {
    assertUnsettable(name, input.operatorSecrets);
    if (name in secrets) {
      delete secrets[name];
      log(
        `removing ${name} from the sealed secrets (the older bundles kept for rollback and any ` +
          'backup still hold it until they are replaced or deleted)'
      );
    } else {
      log(`${name} is not in the sealed secrets; nothing to remove`);
    }
  }
  // The agent signs every answer with this key (server.ts); the Worker holds the public half.
  if (!secrets[SIGNING_KEY_NAME]) {
    secrets[SIGNING_KEY_NAME] = generateAgentSigningKey();
    generated.push(SIGNING_KEY_NAME);
  }
  if (latest && !restored && sameSecrets(secrets, current)) {
    return { bundleId: latest.bundleId, secrets, sealed: false, generated };
  }
  if (input.mode === 'dry-run') {
    log('dry run: a real run would seal a new bundle (nothing written)');
    return { bundleId: DRY_RUN_BUNDLE_ID, secrets, sealed: false, generated };
  }
  const installationId = secrets.SAM_INSTALLATION_ID ?? '';
  if (!/^[0-9a-f]{32}$/.test(installationId)) throw new Error('SAM_INSTALLATION_ID is missing');
  const bundle = await sealSecrets(secrets, provider(), { installationId });
  // Never leave a bundle the key service cannot open: unwrap it once before it is written.
  if (!sameSecrets(await openBundle(bundle, provider()), secrets)) {
    throw new Error(`bundle ${bundle.bundleId} did not open to the secrets it sealed`);
  }
  await settings.bundles.write(bundle);
  log(
    `sealed ${Object.keys(secrets).length} secrets into bundle ${bundle.bundleId} (${provider().name} ${provider().keyRef})`
  );
  // After a restore, every older bundle carries the source install's identity: none is kept.
  const keepIds = restored
    ? [bundle.bundleId]
    : (await listBundles(settings.bundles))
        .slice(0, input.keep ?? DEFAULT_KEPT_BUNDLES)
        .map((b) => b.bundleId);
  for (const id of await pruneBundles(settings.bundles, keepIds)) log(`removed old bundle ${id}`);
  if (restored) {
    rmSync(join(input.stateDir, RESTORED_IDENTITY_FILE));
    log(`sealed this restored install's own identity ${restored.installationId}`);
  }
  return { bundleId: bundle.bundleId, secrets, sealed: true, generated };
}

/**
 * The identity a restore recorded for this clone (restore-identity.ts), checked against the
 * restored bundle: it must still carry the source identity the restore saw.
 */
function readRestoredIdentity(
  stateDir: string,
  latest: SealedBundle | undefined,
  current: Secrets
): { from: string; installationId: string } | null {
  const path = join(stateDir, RESTORED_IDENTITY_FILE);
  if (!existsSync(path)) return null;
  const record = readPrivateJson(path);
  const from = record.SOURCE_INSTALLATION_ID ?? '';
  const installationId = record.SAM_INSTALLATION_ID ?? '';
  if (
    !/^[0-9a-f]{32}$/.test(from) ||
    !/^[0-9a-f]{32}$/.test(installationId) ||
    from === installationId
  ) {
    throw new Error(`${path} is malformed; restore again`);
  }
  if (!latest || latest.installationId !== from || current.SAM_INSTALLATION_ID !== from) {
    throw new Error(
      `${path} names source install ${from}, but the newest sealed bundle is not that install's; restore again`
    );
  }
  return { from, installationId };
}

/**
 * The config handed to `celld deploy`, which celld stores in the fleet bucket for this version.
 * Sealed: exactly the secrets-free config. Otherwise the secrets ride along as vars.
 */
export function celldDeployConfig<C extends { vars: Record<string, string> }>(
  config: C,
  secrets: Readonly<Record<string, string>>,
  sealed: boolean
): C {
  return sealed ? config : { ...config, vars: { ...config.vars, ...secrets } };
}

export function generateAgentSigningKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

/** The Worker's verify key for the agent's answers: the raw Ed25519 public key, base64. */
export function agentVerifyKey(secrets: Readonly<Record<string, string>>): string {
  const der = secrets[SIGNING_KEY_NAME];
  if (!der) throw new Error(`${SIGNING_KEY_NAME} is missing from the sealed secrets`);
  const jwk = createPublicKey(
    createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' })
  ).export({ format: 'jwk' });
  return Buffer.from(String(jwk.x), 'base64url').toString('base64');
}

type PlatformKeys = Record<(typeof PLATFORM_KEY_NAMES)[number], string>;

/**
 * The deploy's platform keys, and with sealed secrets the bundle that holds every secret. Off
 * (`legacy-plaintext`): the plain `platform-keys.json` path (platform-keys.ts), unchanged.
 */
export async function resolveDeployKeys(input: {
  box: Box;
  stateDir: string;
  secretsPath: string;
  mode: PlatformKeysMode;
  log: (message: string) => void;
  /** `pnpm selfhost:deploy --unset NAME`: see ResolveSecretsInput.unset. */
  unset?: readonly string[];
}): Promise<{
  keyService: KeyServiceSettings | null;
  keys: PlatformKeys;
  sealed: ResolvedSecrets | null;
  generated: string[];
}> {
  const { box, stateDir, log, mode } = input;
  const dryRun = mode === 'dry-run';
  const keyService = keyServiceSettings(box, stateDir);
  const platformKeysPath = join(stateDir, PLATFORM_KEYS_FILE);
  if (!keyService) {
    // platform-keys.ts refuses a missing platform-keys.json beside sealed bundles (its
    // PRIOR_DEPLOY_EVIDENCE): going back would generate new keys and lose every credential.
    const ensured = ensurePlatformKeys(stateDir, mode);
    if (!dryRun) {
      for (const path of ensureLegacyAgentEnv(stateDir, keyAgentPort(box))) log(`wrote ${path}`);
    }
    // Not sealed: every secret is rebuilt from secrets.env on each deploy, so deleting the line
    // already removes it. --unset only checks it was deleted.
    checkUnsetNames(
      input.unset ?? [],
      input.secretsPath,
      log,
      (name) =>
        `${name}: this box is not sealed, so deleting its secrets.env line already removed it`
    );
    return { keyService, keys: ensured.keys, sealed: null, generated: ensured.generated };
  }
  if (!dryRun) {
    for (const path of await ensureKeyServiceFiles(keyService)) {
      log(`wrote ${path}`);
      // Once, when the file key is created: the operator must keep a copy off the box.
      if (path === keyService.hostEnv.SAM_KEY_FILE) {
        for (const line of keyFileNotice(path)) log(line);
      }
    }
  }
  const sealed = await resolveSealedSecrets({
    settings: keyService,
    stateDir,
    mode,
    platformKeysFile: existsSync(platformKeysPath) ? readPrivateJson(platformKeysPath) : null,
    operatorSecrets: readSecretsFile(input.secretsPath),
    secretsSource: input.secretsPath,
    unset: dryRun ? [] : input.unset,
    log,
  });
  const keys = Object.fromEntries(
    PLATFORM_KEY_NAMES.map((name) => [name, sealed.secrets[name] ?? ''])
  ) as PlatformKeys;
  return { keyService, keys, sealed, generated: sealed.generated };
}

/** A Worker without its key agent answers 503 to everything; say why before deploying. */
export async function assertKeyAgentUp(port: number): Promise<void> {
  try {
    const { sealed } = await pingKeyAgent(port);
    if (sealed) return;
    throw new Error('it is running with SAM_KEY_PROVIDER=legacy-plaintext; recreate it');
  } catch (error) {
    throw new Error(
      `the key agent is not answering on 127.0.0.1:${port} ` +
        `(${error instanceof Error ? error.message : String(error)}); start it first: docker compose up -d key-agent`
    );
  }
}
