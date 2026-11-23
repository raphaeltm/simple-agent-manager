/**
 * Sealed Worker secrets for a celld box: the default. `SAM_KEY_PROVIDER` in `.env` overrides the
 * provider `--init` chose (key-choice.ts); `legacy-plaintext` keeps the old behaviour.
 *
 * Legacy: the deploy passes every secret as a Worker var, and celld stores each deployed
 * version's vars in plaintext in the fleet bucket. Sealed: the deploy seals the secrets into a
 * bundle (key-seal.ts) under `<state>/key-agent/bundles/`, passes only the bundle id and the
 * agent's loopback address as vars, and the API Worker fetches the secrets at runtime from the `key-agent` compose
 * service (deploy/selfhost/key-agent), which alone can open the bundle with the key service.
 *
 * The deploy calls the provider itself (it runs on the box as the operator, with the same
 * credential the agent uses). It never needs the agent to be up to seal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseBundle, type SealedBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import {
  type BundleStore,
  LOCAL_BUNDLE_SUBDIR,
  openBundleStore,
} from '../../deploy/selfhost/key-agent/bundle-store.ts';
import { pingKeyAgent } from '../../deploy/selfhost/key-agent/healthcheck.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { generateFileKek } from '../../deploy/selfhost/key-agent/provider-file.ts';
import { KEY_PROVIDERS, LEGACY_KEY_PROVIDER } from '../../deploy/selfhost/key-agent/providers.ts';
import { byCreatedAt, type CurrentBundle, headHint, selectCurrentBundle } from './bundle-head.js';
import {
  assertReplaceableSetup,
  fleetBucket,
  mirroredBundleStore,
  replaceableBox,
} from './replaceable-box.js';
import { ensurePrivateDir, writePrivateFile } from './secret-files.js';

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
/** The agent's own tunables (deploy/selfhost/key-agent/server.ts), copied from `.env` when set. */
const AGENT_SETTINGS = [
  'SAM_KEY_AGENT_CACHE_SECONDS',
  'SAM_KEY_AGENT_STALE_WAIT_MS',
  'SAM_KEY_AGENT_MAX_STALE_SECONDS',
  'SAM_KEY_AGENT_CONNECTION_TIMEOUT_MS',
  'SAM_KEY_AGENT_MAX_CONNECTIONS',
] as const;
/** Box files that can unlock the bundle; backups leave them out (backup-lib.ts). */
export const KEY_SERVICE_BACKUP_EXCLUDES = [
  `${KEY_AGENT_DIR}/kek`,
  `${KEY_AGENT_DIR}/credentials`,
  // The head lock (bundle-store.ts withLockFile) names a pid of this box, meaningless anywhere else.
  `${KEY_AGENT_DIR}/head.json.lock`,
  `${KEY_AGENT_DIR}/head.json.lock.break`,
  // The sealing-operation lock (sealing-lock.ts), the same kind of per-box pid file.
  `${KEY_AGENT_DIR}/sealing.lock`,
  `${KEY_AGENT_DIR}/sealing.lock.break`,
];

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
  /** The agent's own tunables from `.env` (cache, stale age, connection limits). */
  agentEnv: Record<string, string>;
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
  // A replaceable box (replaceable-box.ts) seals only with a key held off it, and copies every
  // bundle it writes or prunes to the fleet bucket.
  assertReplaceableSetup(box, provider);
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
  const agentEnv: Record<string, string> = {};
  for (const name of AGENT_SETTINGS) {
    const value = box[name]?.trim();
    if (value) agentEnv[name] = value;
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
    bundles: replaceableBox(box)
      ? mirroredBundleStore(bundleStoreFor(stateDir), fleetBucket(box), stateDir)
      : bundleStoreFor(stateDir),
    hostEnv,
    containerEnv,
    agentEnv,
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
/**
 * A sealed box is never set up as root: the key agent runs as the state owner and refuses uid 0,
 * so a root-owned key file and bundles would need manual ownership repair. Checked before writing.
 */
export function assertNotRootForSealing(stateDir: string, uid = process.getuid?.()): void {
  if (uid === 0) {
    throw new Error(
      `sealed secrets: run the deploy as the user that owns ${stateDir}, not root (the key agent ` +
        'runs as that user and refuses root)'
    );
  }
}

export function assertKeyAgentUid(box: Box, stateDir: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  assertNotRootForSealing(stateDir, uid);
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
    ...settings.agentEnv,
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
export async function ensureKeyServiceFiles(
  settings: KeyServiceSettings,
  options: {
    createKeyFile?: boolean;
    /** false: only the key file (secrets switch writes agent.env itself, after saving the old). */
    writeAgentEnv?: boolean;
  } = {}
): Promise<string[]> {
  const written: string[] = [];
  ensurePrivateDir(settings.dir);
  const keyFile = settings.hostEnv.SAM_KEY_FILE ?? '';
  if (settings.provider === 'file' && !existsSync(keyFile)) {
    // Lost only if a bundle needs it: a box sealed with a cloud key may switch to a new key file
    // (secrets switch --to file). An unreadable bundle counts as needing it.
    let unreadable = false;
    const bundles = await listBundles(settings.bundles, () => {
      unreadable = true;
    });
    if (unreadable || bundles.some((bundle) => bundle.provider === 'file')) {
      throw new Error(
        `${keyFile} is missing but ${settings.bundles.location} holds sealed bundles: the key ` +
          'file was lost. Restore it from the copy you kept off the box; a new key could not ' +
          'open them.'
      );
    }
    if (options.createKeyFile === false) {
      throw new Error(
        `${keyFile} does not exist: run pnpm selfhost:deploy --init first (it creates the key file once)`
      );
    }
    writePrivateFile(keyFile, `${generateFileKek()}\n`);
    written.push(keyFile);
  }
  if (options.writeAgentEnv === false) return written;
  const envPath = join(settings.dir, 'agent.env');
  const env = renderKeyAgentEnv(settings);
  if (!existsSync(envPath) || readFileSync(envPath, 'utf8') !== env) {
    writePrivateFile(envPath, env);
    written.push(envPath);
  }
  return written;
}

/**
 * Bundles in the store, newest `createdAt` first; unreadable ones are reported and skipped. The
 * order is NOT which bundle is current: that is currentBundle (bundle-head.ts).
 */
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
  return byCreatedAt(bundles);
}

/**
 * The store's current bundle (bundle-head.ts selectCurrentBundle, the one selector) and every
 * readable bundle. `provider` opens the head; it is called only when there is one.
 */
export async function currentBundle(
  store: BundleStore,
  provider: KeyProvider | (() => KeyProvider),
  warn: (message: string) => void = console.warn
): Promise<CurrentBundle & { bundles: SealedBundle[] }> {
  const bundles = await listBundles(store, warn);
  const where = `the bundle head beside ${store.location}`;
  return {
    ...(await selectCurrentBundle(bundles, await store.readHead(), provider, where)),
    bundles,
  };
}

/**
 * Removes every bundle not in `keepIds`. Never the one the head names, whatever the caller asked:
 * a head naming a missing bundle stops every later deploy.
 */
export async function pruneBundles(
  store: BundleStore,
  keepIds: readonly string[]
): Promise<string[]> {
  // Under the head lock: a seal that commits its head between this read and the removals would
  // otherwise have its newly current bundle removed. commitHead checks its bundle is still there
  // under the same lock, so a seal racing this prune fails instead of naming a missing bundle.
  return await store.withHeadLock(async () => {
    const removed: string[] = [];
    const named = headHint(await store.readHead())?.bundleId;
    for (const bundle of await listBundles(store)) {
      if (keepIds.includes(bundle.bundleId) || bundle.bundleId === named) continue;
      await store.remove(bundle.bundleId);
      removed.push(bundle.bundleId);
    }
    return removed;
  });
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
