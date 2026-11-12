/**
 * Sealed Worker secrets for a celld box (opt-in: `SAM_KEY_PROVIDER` in `.env`).
 *
 * Without it the deploy passes every secret as a Worker var, and celld stores each deployed
 * version's vars in plaintext in the fleet bucket. With it the deploy seals the secrets into a
 * bundle under `<state>/key-agent/bundles/`, passes only the bundle id and the agent's loopback
 * URL as vars, and the API Worker fetches the secrets at runtime from the `key-agent` compose
 * service (deploy/selfhost/key-agent), which alone can open the bundle with the key service.
 *
 * The deploy calls the provider itself (it runs on the box as the operator, with the same
 * credential the agent uses). It never needs the agent to be up to seal.
 */
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
import { createKeyProvider, KEY_PROVIDERS } from '../../deploy/selfhost/key-agent/providers.ts';
import { completePlatformKeys, PLATFORM_KEY_NAMES } from './platform-keys.js';
import { ensurePrivateDir, writePrivateFile } from './secret-files.js';

export const KEY_AGENT_DIR = 'key-agent';
export const KEY_AGENT_PROFILE = 'key-agent';
export const DEFAULT_KEY_AGENT_PORT = 7190;
/** Bundles kept after a seal: the Worker version still running during a deploy asks for its own. */
export const DEFAULT_KEPT_BUNDLES = 3;
/** Where the compose service mounts `<state>/key-agent` (docker-compose.yml). */
const CONTAINER_DIR = '/etc/sam/key-agent';
/** Credential files a provider may read, relative to `<state>/key-agent/credentials/`. */
const CREDENTIAL_FILES: Readonly<Record<string, string>> = {
  SAM_TRANSIT_TOKEN_FILE: 'transit-token',
  SAM_TRANSIT_SECRET_ID_FILE: 'transit-secret-id',
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

export function keyServiceEnabled(box: Box): boolean {
  const value = box.SAM_KEY_PROVIDER?.trim() ?? '';
  return value !== '' && value !== 'off';
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
    throw new Error(`SAM_KEY_PROVIDER must be off or one of ${Object.keys(KEY_PROVIDERS).join(', ')}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && box.SAM_KEY_AGENT_UID?.trim() !== String(uid)) {
    throw new Error(
      `SAM_KEY_AGENT_UID must be ${uid}, the uid that owns ${stateDir}: the key-agent container ` +
        'runs as it to read the sealed bundles and the key file (mode 0600)'
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
  return { provider, port: keyAgentPort(box), dir, bundleDir: join(dir, 'bundles'), hostEnv, containerEnv };
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
export function listBundles(bundleDir: string, warn: (message: string) => void = console.warn): SealedBundle[] {
  if (!existsSync(bundleDir)) return [];
  const bundles: SealedBundle[] = [];
  for (const name of readdirSync(bundleDir)) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    try {
      const bundle = parseBundle(readFileSync(join(bundleDir, name), 'utf8'));
      if (`${bundle.bundleId}.json` !== name) throw new Error('file name does not match its id');
      bundles.push(bundle);
    } catch (error) {
      warn(`[selfhost] skipping ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return bundles.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
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
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
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
  const { keys, generated } = completePlatformKeys({ ...current, ...fromFile });
  const secrets: Secrets = { ...current, ...keys, ...input.operatorSecrets };
  if (latest && sameSecrets(secrets, current)) {
    return { bundleId: latest.bundleId, secrets, sealed: false, generated };
  }
  const installationId = secrets.SAM_INSTALLATION_ID ?? '';
  if (!/^[0-9a-f]{32}$/.test(installationId)) throw new Error('SAM_INSTALLATION_ID is missing');
  ensurePrivateDir(settings.bundleDir);
  const bundle = await sealSecrets(secrets, provider, { installationId });
  writePrivateFile(join(settings.bundleDir, `${bundle.bundleId}.json`), `${JSON.stringify(bundle, null, 2)}\n`);
  log(`sealed ${Object.keys(secrets).length} secrets into bundle ${bundle.bundleId} (${provider.name} ${provider.keyRef})`);
  const keepIds = listBundles(settings.bundleDir)
    .slice(0, input.keep ?? DEFAULT_KEPT_BUNDLES)
    .map((b) => b.bundleId);
  for (const id of pruneBundles(settings.bundleDir, keepIds)) log(`removed old bundle ${id}`);
  return { bundleId: bundle.bundleId, secrets, sealed: true, generated };
}

/** The key-agent compose profile and SAM_KEY_PROVIDER must agree, like the gce profile. */
export function assertKeyAgentProfile(box: Box): void {
  const profiles = (box.COMPOSE_PROFILES ?? '').split(',').map((p) => p.trim());
  const wanted = keyServiceEnabled(box);
  if (wanted && !profiles.includes(KEY_AGENT_PROFILE)) {
    throw new Error('SAM_KEY_PROVIDER is set: add `key-agent` to COMPOSE_PROFILES');
  }
  if (!wanted && profiles.includes(KEY_AGENT_PROFILE)) {
    throw new Error('COMPOSE_PROFILES has `key-agent` but SAM_KEY_PROVIDER is off; remove it');
  }
}
