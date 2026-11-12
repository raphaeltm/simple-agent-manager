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
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  openBundle,
  parseBundle,
  type SealedBundle,
  sealSecrets,
  type Secrets,
} from '../../deploy/selfhost/key-agent/bundle.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { generateFileKek } from '../../deploy/selfhost/key-agent/provider-file.ts';
import {
  createKeyProvider,
  KEY_PROVIDERS,
  LEGACY_KEY_PROVIDER,
} from '../../deploy/selfhost/key-agent/providers.ts';
import { SIGNING_KEY_NAME } from '../../deploy/selfhost/key-agent/server.ts';
import { completePlatformKeys, ensurePlatformKeys, PLATFORM_KEY_NAMES } from './platform-keys.js';
import {
  ensurePrivateDir,
  readPrivateJson,
  readSecretsFile,
  writePrivateFile,
} from './secret-files.js';

export { LEGACY_KEY_PROVIDER };
export const KEY_AGENT_DIR = 'key-agent';
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
  bundleDir: string;
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
  // Optional: unset, the agent drops to the owner of the key-agent directory (server.ts).
  const uid = process.getuid?.();
  const pinned = box.SAM_KEY_AGENT_UID?.trim();
  if (uid !== undefined && pinned && pinned !== String(uid)) {
    throw new Error(
      `SAM_KEY_AGENT_UID must be ${uid} (the uid that owns ${stateDir}) or unset: the key-agent ` +
        'container must run as the owner of the sealed bundles and the key file (mode 0600)'
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
    bundleDir: join(dir, 'bundles'),
    hostEnv,
    containerEnv,
  };
}

/** The Worker's view of the agent; a loopback URL only celld's uid may use. */
export function keyAgentUrl(settings: Pick<KeyServiceSettings, 'port'>): string {
  return `http://127.0.0.1:${settings.port}/v1/secrets`;
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

/** Creates the agent's directories, and the file provider's KEK once. */
export function ensureKeyServiceFiles(settings: KeyServiceSettings): string[] {
  const written: string[] = [];
  ensurePrivateDir(settings.dir);
  ensurePrivateDir(settings.bundleDir);
  if (settings.provider === 'file' && !existsSync(settings.hostEnv.SAM_KEY_FILE ?? '')) {
    writePrivateFile(settings.hostEnv.SAM_KEY_FILE ?? '', `${generateFileKek()}\n`);
    written.push(settings.hostEnv.SAM_KEY_FILE ?? '');
  }
  const envPath = join(settings.dir, 'agent.env');
  const env = renderKeyAgentEnv(settings);
  if (!existsSync(envPath) || readFileSync(envPath, 'utf8') !== env) {
    writePrivateFile(envPath, env);
    written.push(envPath);
  }
  return written;
}

/** Bundles in the directory, newest first; unreadable files are reported and skipped. */
export function listBundles(
  bundleDir: string,
  warn: (message: string) => void = console.warn
): SealedBundle[] {
  if (!existsSync(bundleDir)) return [];
  const bundles: SealedBundle[] = [];
  for (const name of readdirSync(bundleDir)) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    try {
      const bundle = parseBundle(readFileSync(join(bundleDir, name), 'utf8'));
      if (`${bundle.bundleId}.json` !== name) throw new Error('file name does not match its id');
      bundles.push(bundle);
    } catch (error) {
      warn(
        `[selfhost] skipping ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return bundles.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
}

export function pruneBundles(bundleDir: string, keepIds: readonly string[]): string[] {
  const removed: string[] = [];
  for (const bundle of listBundles(bundleDir)) {
    if (keepIds.includes(bundle.bundleId)) continue;
    rmSync(join(bundleDir, `${bundle.bundleId}.json`));
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
  provider?: KeyProvider;
  /** `.state/platform-keys.json` when it still exists (an install migrating from plain files). */
  platformKeysFile: Record<string, string> | null;
  /** `.state/secrets.env`, merged last as today: the operator's edits win. */
  operatorSecrets: Record<string, string>;
  keep?: number;
  log?: (message: string) => void;
}

export interface ResolvedSecrets {
  bundleId: string;
  secrets: Secrets;
  sealed: boolean;
  generated: string[];
}

/**
 * The secrets this deploy runs with, and the bundle that holds them. Opens the newest bundle,
 * lays the plaintext migration files over it, generates any platform key still missing, and seals
 * a new bundle only when the result differs. A platform key whose file value disagrees with the
 * bundle stops the deploy: silently replacing ENCRYPTION_KEY would make every stored credential
 * undecryptable.
 */
export async function resolveSealedSecrets(input: ResolveSecretsInput): Promise<ResolvedSecrets> {
  const { settings } = input;
  const log = input.log ?? (() => undefined);
  const provider = input.provider ?? createKeyProvider(settings.hostEnv);
  const latest = listBundles(settings.bundleDir)[0];
  const current = latest ? await openBundle(latest, provider) : {};
  const fromFile = input.platformKeysFile ?? {};
  for (const name of PLATFORM_KEY_NAMES) {
    const sealed = current[name];
    const plain = fromFile[name];
    if (sealed !== undefined && plain !== undefined && sealed !== plain) {
      throw new Error(
        `${name} in platform-keys.json differs from the sealed bundle ${latest?.bundleId}; ` +
          'refusing to rotate a platform key. Remove the stale file or restore the matching one.'
      );
    }
  }
  const completed = completePlatformKeys({ ...current, ...fromFile });
  const keys = completed.keys;
  const generated: string[] = [...completed.generated];
  const secrets: Secrets = { ...current, ...keys, ...input.operatorSecrets };
  // The agent signs every answer with this key (server.ts); the Worker holds the public half.
  if (!secrets[SIGNING_KEY_NAME]) {
    secrets[SIGNING_KEY_NAME] = generateAgentSigningKey();
    generated.push(SIGNING_KEY_NAME);
  }
  if (latest && sameSecrets(secrets, current)) {
    return { bundleId: latest.bundleId, secrets, sealed: false, generated };
  }
  const installationId = secrets.SAM_INSTALLATION_ID ?? '';
  if (!/^[0-9a-f]{32}$/.test(installationId)) throw new Error('SAM_INSTALLATION_ID is missing');
  ensurePrivateDir(settings.bundleDir);
  const bundle = await sealSecrets(secrets, provider, { installationId });
  // Never leave a bundle the key service cannot open: unwrap it once before it is written.
  if (!sameSecrets(await openBundle(bundle, provider), secrets)) {
    throw new Error(`bundle ${bundle.bundleId} did not open to the secrets it sealed`);
  }
  writePrivateFile(
    join(settings.bundleDir, `${bundle.bundleId}.json`),
    `${JSON.stringify(bundle, null, 2)}\n`
  );
  log(
    `sealed ${Object.keys(secrets).length} secrets into bundle ${bundle.bundleId} (${provider.name} ${provider.keyRef})`
  );
  const keepIds = listBundles(settings.bundleDir)
    .slice(0, input.keep ?? DEFAULT_KEPT_BUNDLES)
    .map((b) => b.bundleId);
  for (const id of pruneBundles(settings.bundleDir, keepIds)) log(`removed old bundle ${id}`);
  return { bundleId: bundle.bundleId, secrets, sealed: true, generated };
}

/**
 * The config handed to `celld deploy`, which celld stores in the fleet bucket for this version.
 * Sealed: exactly the secrets-free config. Otherwise the secrets ride along as vars (today's path).
 */
export function celldDeployConfig<C extends { vars: Record<string, string> }>(
  config: C,
  secrets: Readonly<Record<string, string>>,
  sealed: boolean
): C {
  return sealed ? config : { ...config, vars: { ...config.vars, ...secrets } };
}

function generateAgentSigningKey(): string {
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
 * The deploy's platform keys, and with sealed secrets the bundle that holds every secret. Off:
 * the plain `platform-keys.json` path, unchanged.
 */
export async function resolveDeployKeys(input: {
  box: Box;
  stateDir: string;
  secretsPath: string;
  log: (message: string) => void;
}): Promise<{
  keyService: KeyServiceSettings | null;
  keys: PlatformKeys;
  sealed: ResolvedSecrets | null;
}> {
  const { box, stateDir, log } = input;
  const keyService = keyServiceSettings(box, stateDir);
  const platformKeysPath = join(stateDir, 'platform-keys.json');
  if (!keyService) {
    // A sealed box has no platform-keys.json: the legacy path would generate NEW keys, and every
    // credential stored under the old ENCRYPTION_KEY would become unreadable.
    if (
      !existsSync(platformKeysPath) &&
      listBundles(join(stateDir, KEY_AGENT_DIR, 'bundles')).length > 0
    ) {
      throw new Error(
        `${LEGACY_KEY_PROVIDER} needs ${platformKeysPath}, but this box's platform keys are sealed ` +
          '(key-agent/bundles). Going back would generate new keys and lose every stored ' +
          'credential: remove SAM_KEY_PROVIDER, or restore platform-keys.json from a backup taken ' +
          'before the box was sealed'
      );
    }
    for (const path of ensureLegacyAgentEnv(stateDir, keyAgentPort(box))) log(`wrote ${path}`);
    const ensured = ensurePlatformKeys(platformKeysPath);
    if (ensured.generated.length > 0) {
      log(`generated platform keys: ${ensured.generated.join(', ')} (back up ${stateDir})`);
    }
    return { keyService, keys: ensured.keys, sealed: null };
  }
  for (const path of ensureKeyServiceFiles(keyService)) log(`wrote ${path}`);
  const sealed = await resolveSealedSecrets({
    settings: keyService,
    platformKeysFile: existsSync(platformKeysPath) ? readPrivateJson(platformKeysPath) : null,
    operatorSecrets: readSecretsFile(input.secretsPath),
    log,
  });
  if (sealed.generated.length > 0) {
    log(`generated platform keys into the sealed bundle: ${sealed.generated.join(', ')}`);
  }
  const keys = Object.fromEntries(
    PLATFORM_KEY_NAMES.map((name) => [name, sealed.secrets[name] ?? ''])
  ) as PlatformKeys;
  return { keyService, keys, sealed };
}

/** A Worker without its key agent answers 503 to everything; say why before deploying. */
export async function assertKeyAgentUp(port: number): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) return;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `the key agent is not answering on 127.0.0.1:${port} ` +
        `(${error instanceof Error ? error.message : String(error)}); start it first: docker compose up -d key-agent`
    );
  }
}
