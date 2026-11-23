/**
 * `pnpm selfhost:secrets migrate [--key-copy <path>]`: move a running plaintext install to sealed
 * secrets in one command, and back automatically if the switch does not work.
 *
 *  1. `pnpm selfhost:deploy --init`: choose the provider (key-choice.ts) and seal the existing
 *     platform-keys.json and secrets.env, unchanged, into a bundle.
 *  2. Contract check (secrets-preflight.ts): the real agent code answers the real Worker loader
 *     with every secret the plaintext files hold. Fails here: nothing has switched.
 *  3. `docker compose up -d --build`: the key agent starts and the fence lets celld reach it.
 *  4. `pnpm selfhost:deploy`: the switch. The new Worker version carries no secret vars.
 *  5. celld adopts it now (`POST /reload` on its internal listener), and the first request to the
 *     new version must be healthy; the current deploy version in the bucket must hold no secret.
 *  6. Only then are the plaintext files removed, and with the file key only once `--key-copy`
 *     proves a matching copy exists: until then those files are the only other copy of the
 *     platform keys.
 *
 * A failure after step 4 started redeploys the previous behaviour
 * (`pnpm selfhost:deploy --key-provider legacy-plaintext`), whose plaintext files are still there.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { explicitKeyProvider, keyChoicePath, readKeyChoice } from './key-choice';
import { bundleStoreFor, LEGACY_KEY_PROVIDER } from './key-service';
import { fleetBucket, mirroredBundleStore, replaceableBox } from './replaceable-box';
import { readPrivateJson, readSecretsFile } from './secret-files';
import { keyFileNotice, keyFilePath, verifyKeyCopy } from './secrets-keyfile';
import { type preflightSealedSecrets } from './secrets-preflight';
import { PLAINTEXT_SECRET_FILES } from './secrets-status';

export interface MigrateDeps {
  log: (message: string) => void;
  /** `pnpm selfhost:deploy --init`. */
  init: () => Promise<void>;
  preflight: typeof preflightSealedSecrets;
  /** `docker compose up -d --build`, then wait until the key agent answers its health check. */
  startStack: () => Promise<void>;
  /** `pnpm selfhost:deploy`, or with `--key-provider legacy-plaintext` for the rollback. */
  deploy: (legacy: boolean) => Promise<void>;
  /** celld adopts the newest deployment now; then one request to the API. */
  adoptAndCheck: () => Promise<{ healthy: boolean; detail: string }>;
  /** Secret names in the deploy version deploy/current.json names (plaintext-scan.ts). */
  currentVersionSecrets: () => Promise<string[]>;
  /** SAM_SECRET_BUNDLE_ID of that version, or null when it names none. */
  currentVersionBundleId: () => Promise<string | null>;
}

export interface MigrateInput {
  box: Readonly<Record<string, string>>;
  stateDir: string;
  /** A copy of the file key, checked before the plaintext files go. */
  keyCopy?: string;
}

export type MigrateOutcome = 'nothing-to-migrate' | 'migrated' | 'migrated-files-kept';

/**
 * Written just before step 6 removes the plaintext files and removed after the last one goes: the
 * evidence that a leftover secrets.env is this command's unfinished removal, not a sealed box's
 * ordinary operator input (deploy seals secrets.env on every run).
 */
export const CLEANUP_MARKER = 'migrate-cleanup.pending';

function plaintext(stateDir: string): Record<string, string> {
  const keys = join(stateDir, 'platform-keys.json');
  return {
    ...(existsSync(keys) ? readPrivateJson(keys) : {}),
    ...readSecretsFile(join(stateDir, 'secrets.env')),
  };
}

export async function runMigration(
  input: MigrateInput,
  deps: MigrateDeps
): Promise<MigrateOutcome> {
  const { stateDir } = input;
  const { log } = deps;
  if (explicitKeyProvider(input.box) === LEGACY_KEY_PROVIDER) {
    throw new Error(
      `.env sets SAM_KEY_PROVIDER=${LEGACY_KEY_PROVIDER}: remove that line to migrate`
    );
  }
  // platform-keys.json goes last: its presence is what marks the box as not yet migrated, so an
  // interrupted removal can only leave it behind together with the rest, never secrets.env alone.
  const files = PLAINTEXT_SECRET_FILES.filter((name) => existsSync(join(stateDir, name))).sort(
    (a, b) => Number(a === 'platform-keys.json') - Number(b === 'platform-keys.json')
  );
  if (!existsSync(join(stateDir, 'platform-keys.json'))) {
    // A run that stopped between its removals (its marker says so) left secrets.env: finish once
    // the sealed version runs AND the sealed bundle holds every value the file holds now, so a
    // credential added or changed since is never deleted unsealed.
    if (files.length > 0 && existsSync(join(stateDir, CLEANUP_MARKER))) {
      const running = await deps.adoptAndCheck();
      if (!running.healthy || (await deps.currentVersionSecrets()).length > 0) {
        throw new Error(
          `a previous migrate stopped while removing the plaintext files, but the running version ` +
            `is not sealed and healthy (${running.detail}); nothing removed`
        );
      }
      await deps.preflight({ box: input.box, stateDir, expected: plaintext(stateDir) });
      log('a previous migrate stopped before removing every plaintext file; finishing that');
      return removePlaintext(input, files, log);
    }
    log('no platform-keys.json on this box: it is already sealed (or new). Nothing to migrate.');
    log('Old copies may remain in the bucket and backups: pnpm selfhost:secrets plaintext');
    return 'nothing-to-migrate';
  }
  const expected = plaintext(stateDir);
  // The recorded choice is what tells selfhost:upgrade this box is sealed (upgrade-sealing.ts).
  // A migration that stops before the sealed version is live forgets a choice it made itself, so
  // the next upgrade keeps the box on plaintext instead of sealing it outside this command.
  const choiceRecordedBefore = existsSync(keyChoicePath(stateDir));
  const forgetNewChoice = () => {
    if (!choiceRecordedBefore) rmSync(keyChoicePath(stateDir), { force: true });
  };
  // A failed attempt also removes the bundles it sealed. A retry must start from the plaintext
  // files as they are then: a leftover bundle would be its base, and a secret the operator deleted
  // from secrets.env in between would survive into the sealed set. No running version names a
  // bundle this attempt created (it never switched, or it was rolled back first).
  // On a replaceable box the attempt's --init wrote through the bucket copy too: undo it there
  // as well, or the bucket keeps a head (and bundles) later than the box and every deploy stops.
  const store = replaceableBox(input.box)
    ? mirroredBundleStore(bundleStoreFor(stateDir), fleetBucket(input.box), stateDir)
    : bundleStoreFor(stateDir);
  const bundlesBefore = new Set(await store.listIds());
  const headBefore = await store.readHead();
  // Each step on its own: a bucket that fails (often what failed the attempt) must not stop the
  // box's own copy from being undone, or a retry would start from this attempt's bundle. A bucket
  // left ahead of the box stops the next deploy (reconcile) until it is repaired; never stale.
  const undo = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      log(
        `    could not undo ${what}: ${error instanceof Error ? error.message : String(error)}. ` +
          'If that was the fleet bucket, remove the copy under sam-box/ by hand once it is ' +
          'reachable (match the box: pnpm selfhost:secrets status), or the next deploy refuses'
      );
    }
  };
  const forgetNewBundles = async () => {
    // The head as it was first (bundle-head.ts): it must never name a bundle removed below.
    if ((await store.readHead()) !== headBefore) {
      await undo('the bundle head', () =>
        headBefore === null ? store.removeHead() : store.writeHead(headBefore)
      );
    }
    for (const id of await store.listIds()) {
      if (bundlesBefore.has(id)) continue;
      await undo(`bundle ${id}`, async () => {
        await store.remove(id);
        log(`    removed bundle ${id}, sealed by this failed attempt`);
      });
    }
  };

  let alreadySealed = false;
  let bundleId = '';
  try {
    log('1/6 choosing the key provider and sealing the existing secrets (selfhost:deploy --init)');
    await deps.init();
    log('2/6 contract check: key agent -> Worker loader, every secret unchanged');
    const checked = await deps.preflight({ box: input.box, stateDir, expected });
    bundleId = checked.bundleId;
    log(`    bundle ${bundleId}: the Worker gets ${checked.checked} secrets`);
    log('3/6 starting the key agent and the updated fence (docker compose up -d --build)');
    await deps.startStack();
    // Already switched (a selfhost:upgrade ran the sealed deploy, or an earlier migrate kept the
    // files) when the running version holds no secret vars. A failed scan is still pre-switch.
    alreadySealed = (await deps.currentVersionSecrets()).length === 0;
  } catch (error) {
    forgetNewChoice();
    await forgetNewBundles();
    throw error;
  }

  // Verify what runs and go straight to the removal. If the running version names an older bundle
  // (secrets.env changed since an earlier migrate kept the files), the checked bundle is deployed
  // first: the files may go only once the Worker runs the bundle that holds them. The box already
  // runs sealed, so a failure here leaves it as it is (no plaintext rollback) and removes nothing.
  if (alreadySealed) {
    const runningBundle = await deps.currentVersionBundleId();
    if (runningBundle !== bundleId) {
      log(`4/6 the running version uses bundle ${runningBundle}; deploying ${bundleId} first`);
      await deps.deploy(false);
    }
    const running = await deps.adoptAndCheck();
    if (!running.healthy) {
      throw new Error(
        `the running sealed version is not healthy (${running.detail}); fix that first`
      );
    }
    log('4/6 5/6 a sealed version is already current and healthy; no redeploy needed');
    return removePlaintext(input, files, log);
  }

  let switched = false;
  try {
    log('4/6 deploying the Worker without secret vars (selfhost:deploy)');
    switched = true;
    await deps.deploy(false);
    log('5/6 adopting the new version now and checking it');
    const check = await deps.adoptAndCheck();
    if (!check.healthy) throw new Error(`the new version is not healthy: ${check.detail}`);
    const leaked = await deps.currentVersionSecrets();
    if (leaked.length > 0) {
      throw new Error(`the current deploy version still holds secret vars: ${leaked.join(', ')}`);
    }
  } catch (error) {
    if (!switched) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    log(`migration FAILED: ${reason}`);
    // Forgotten first: should the rollback deploy fail too, the box (still on its plaintext files)
    // must not look sealed to the next selfhost:upgrade.
    forgetNewChoice();
    log(`rolling back: selfhost:deploy --key-provider ${LEGACY_KEY_PROVIDER}`);
    await deps.deploy(true);
    const back = await deps.adoptAndCheck();
    // Only once the plaintext version is running again does no version need the new bundles.
    if (back.healthy) await forgetNewBundles();
    log(
      back.healthy
        ? 'rolled back: the install runs on plaintext deploy vars again, nothing was removed'
        : `ROLLBACK NOT HEALTHY (${back.detail}): check docker compose ps and the celld log`
    );
    log(
      `To stay on the old behaviour until this is fixed, set SAM_KEY_PROVIDER=${LEGACY_KEY_PROVIDER} in .env.`
    );
    throw new Error(`migration rolled back: ${reason}`);
  }

  return removePlaintext(input, files, log);
}

/** Step 6: the plaintext files go only when the key itself is safe (module comment). */
function removePlaintext(
  input: MigrateInput,
  files: readonly string[],
  log: (message: string) => void
): MigrateOutcome {
  const { stateDir } = input;
  const choice = readKeyChoice(stateDir);
  const provider = explicitKeyProvider(input.box) ?? choice?.provider ?? '';
  if (provider === 'file') {
    const keyFile = keyFilePath(stateDir);
    for (const line of keyFileNotice(keyFile)) log(line);
    const copy = input.keyCopy ? verifyKeyCopy(stateDir, input.keyCopy) : null;
    if (!copy?.ok) {
      log(copy ? copy.message : 'no --key-copy given');
      log(
        `6/6 KEPT ${files.join(', ')}: they are the only other copy of the platform keys until a ` +
          'copy of the key file is stored off the box. Store one, then run: ' +
          'pnpm selfhost:secrets migrate --key-copy <path to the copy>'
      );
      return 'migrated-files-kept';
    }
    log(copy.message);
  }
  const marker = join(stateDir, CLEANUP_MARKER);
  writeFileSync(marker, `${files.join('\n')}\n`, { mode: 0o600 });
  for (const name of files) rmSync(join(stateDir, name));
  rmSync(marker);
  log(`6/6 removed ${files.join(', ')}; the box's Worker secrets are sealed (${provider})`);
  log('Old copies remain in the bucket and backups: pnpm selfhost:secrets plaintext');
  return 'migrated';
}
