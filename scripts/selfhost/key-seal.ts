/**
 * Sealing on the deploy side (key-service.ts holds the box settings and the bundle listing): the
 * secrets a deploy runs with and the bundle that holds them, the platform keys under
 * platform-keys.ts's rules, `--unset`, a restored clone's identity, and the Worker's view of the
 * agent (its verify key, the secrets-free celld config).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  openBundle,
  type SealedBundle,
  sealSecrets,
  type Secrets,
} from '../../deploy/selfhost/key-agent/bundle.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { SIGNING_KEY_NAME } from '../../deploy/selfhost/key-agent/server.ts';
import {
  assertSecretsMatchHead,
  commitHead,
  keptBundleIds,
  selectCurrentBundle,
} from './bundle-head.js';
import {
  assertNotRootForSealing,
  DEFAULT_KEPT_BUNDLES,
  ensureKeyServiceFiles,
  ensureLegacyAgentEnv,
  keyAgentPort,
  type KeyServiceSettings,
  keyServiceSettings,
  listBundles,
  pruneBundles,
  RESTORED_IDENTITY_FILE,
} from './key-service.js';
import {
  assertSecretsKeepPlatformKeys,
  completeSealedPlatformKeys,
  ensurePlatformKeys,
  PLATFORM_KEY_NAMES,
  PLATFORM_KEYS_FILE,
  type PlatformKeysMode,
} from './platform-keys.js';
import { LEDGER_SECRET } from './replaceable-box.js';
import { acquireSealingLock } from './sealing-lock.js';
import { readPrivateJson, readSecretsFile } from './secret-files.js';
import { keyFileNotice } from './secrets-keyfile.js';

type Box = Readonly<Record<string, string | undefined>>;

/** The Worker vars that point it at the agent (sealedWorkerVars); never operator secrets. */
const CHANNEL_VARS = new Set([
  'SAM_KEY_AGENT_ADDRESS',
  'SAM_SECRET_BUNDLE_ID',
  'SAM_KEY_AGENT_VERIFY_KEY',
  'SAM_KEY_AGENT_TIMEOUT_MS',
  'SAM_RUNTIME_SECRETS_TTL_MS',
  'SAM_RUNTIME_SECRETS_MAX_STALE_MS',
]);

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
   * secrets.env over the current bundle, so deleting a line never removed a sealed value (box
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
 * The secrets this deploy runs with, and the bundle that holds them. Opens the current bundle
 * (bundle-head.ts),
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
  // An unreadable bundle may be the current one (or, without a head yet, the newest): deploying
  // from another could roll back a changed credential or bring back an unset one. Refuse instead.
  const unreadable: string[] = [];
  const bundles = await listBundles(settings.bundles, (message) => unreadable.push(message));
  if (unreadable.length > 0) {
    throw new Error(
      `${settings.bundles.location} holds a sealed bundle that cannot be read, so the current ` +
        `secrets are unknown; refusing to deploy from another one.\n${unreadable.join('\n')}\n` +
        'Restore that bundle from backup (pnpm selfhost:restore), or remove it if you know it is ' +
        'not the current one.'
    );
  }
  const { bundle: latest, head } = await selectCurrentBundle(
    bundles,
    await settings.bundles.readHead(),
    provider,
    `the bundle head beside ${settings.bundles.location}`
  );
  // Not an error (a seal that stopped before its head, or a clock that moved back, leaves one),
  // but worth saying: an older SAM version run by hand seals without moving the head.
  for (const later of head && latest ? bundles.filter((b) => b.createdAt > latest.createdAt) : []) {
    log(
      `note: bundle ${later.bundleId} is dated after the current one (${latest?.bundleId}) but ` +
        'the head does not name it: a seal that stopped part way, a clock that moved back, or ' +
        'an older SAM version that does not keep the head. This deploy runs the current one.'
    );
  }
  const current = latest ? await openBundle(latest, provider()) : {};
  assertSecretsMatchHead(head, current);
  const record = readRestoredIdentity(input.stateDir, latest, current);
  if (record === 'done' && input.mode !== 'dry-run') {
    rmSync(join(input.stateDir, RESTORED_IDENTITY_FILE));
  }
  const restored = record === 'done' ? null : record;
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
  // secrets.env is laid over the keys below; it may not replace one (as on a legacy box), nor the
  // agent's signing key or the Worker's channel settings (security review L-4).
  for (const name of Object.keys(input.operatorSecrets)) {
    // SAM_BOX_LEDGER names the replaceable box's sealed ledger (replaceable-box.ts); rebuild
    // refuses a Worker bundle holding it, so it is never sealed as an operator secret.
    if (name === SIGNING_KEY_NAME || CHANNEL_VARS.has(name) || name === LEDGER_SECRET) {
      throw new Error(
        `${input.secretsSource ?? 'secrets.env'}: ${name} is set by the sealed deploy; remove it`
      );
    }
  }
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
    // A box from before the head deploys what it always did (the newest createdAt) and records
    // it now, so its next deploy no longer depends on the clock.
    if (!head && input.mode !== 'dry-run') {
      await commitHead(settings.bundles, latest, provider(), null);
      log(`recorded bundle ${latest.bundleId} as the current sealed bundle (bundle head)`);
    }
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
  // The head, not the bundle's date, makes it current (bundle-head.ts): a host clock that moved
  // backwards since the last seal cannot make the next deploy pick an older bundle.
  await commitHead(settings.bundles, bundle, provider(), head);
  log(
    `sealed ${Object.keys(secrets).length} secrets into bundle ${bundle.bundleId} (${provider().name} ${provider().keyRef})`
  );
  // After a restore, every older bundle carries the source install's identity: none is kept.
  // Otherwise the bundle just made current, the one it replaced (the running Worker version asks
  // for it until the deploy finishes), then the newest others.
  const keepIds = restored
    ? [bundle.bundleId]
    : keptBundleIds(
        await listBundles(settings.bundles),
        bundle.bundleId,
        latest?.bundleId,
        input.keep ?? DEFAULT_KEPT_BUNDLES
      );
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
): { from: string; installationId: string } | 'done' | null {
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
  // Already sealed in by an --init that stopped before removing the record (security review L-1).
  if (latest?.installationId === installationId && current.SAM_INSTALLATION_ID === installationId) {
    return 'done';
  }
  if (!latest || latest.installationId !== from || current.SAM_INSTALLATION_ID !== from) {
    throw new Error(
      `${path} names source install ${from}, but the current sealed bundle is not that install's; restore again`
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
  // Before anything is written: a root --init would leave root-owned state the agent cannot use.
  if (!dryRun) assertNotRootForSealing(stateDir);
  if (!dryRun) {
    // Only --init creates the file key (security review L-2): a plain deploy with no key file
    // stops instead of writing one that could never open a restored bundle.
    for (const path of await ensureKeyServiceFiles(keyService, {
      createKeyFile: mode === 'init',
    })) {
      log(`wrote ${path}`);
      // Once, when the file key is created: the operator must keep a copy off the box.
      if (path === keyService.hostEnv.SAM_KEY_FILE) {
        for (const line of keyFileNotice(path)) log(line);
      }
    }
  }
  // Held until this deploy process exits, after its Worker is published (sealing-lock.ts): two
  // overlapping deploys cannot publish in the opposite order to their seals. Taken after every
  // refusal above, so a refused deploy writes nothing; a dry run only reads.
  if (!dryRun) await acquireSealingLock(stateDir);
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
