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
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { explicitKeyProvider, readKeyChoice } from './key-choice';
import { LEGACY_KEY_PROVIDER } from './key-service';
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
}

export interface MigrateInput {
  box: Readonly<Record<string, string>>;
  stateDir: string;
  /** A copy of the file key, checked before the plaintext files go. */
  keyCopy?: string;
}

export type MigrateOutcome = 'nothing-to-migrate' | 'migrated' | 'migrated-files-kept';

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
  const files = PLAINTEXT_SECRET_FILES.filter((name) => existsSync(join(stateDir, name)));
  if (!existsSync(join(stateDir, 'platform-keys.json'))) {
    log('no platform-keys.json on this box: it is already sealed (or new). Nothing to migrate.');
    log('Old copies may remain in the bucket and backups: pnpm selfhost:secrets plaintext');
    return 'nothing-to-migrate';
  }
  const expected = plaintext(stateDir);

  log('1/6 choosing the key provider and sealing the existing secrets (selfhost:deploy --init)');
  await deps.init();
  log('2/6 contract check: key agent -> Worker loader, every secret unchanged');
  const checked = await deps.preflight({ box: input.box, stateDir, expected });
  log(`    bundle ${checked.bundleId}: the Worker gets ${checked.checked} secrets`);
  log('3/6 starting the key agent and the updated fence (docker compose up -d --build)');
  await deps.startStack();

  // Already switched (a selfhost:upgrade ran the sealed deploy, or an earlier migrate kept the
  // files): verify what runs and go straight to the removal.
  if ((await deps.currentVersionSecrets()).length === 0) {
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
    log(`rolling back: selfhost:deploy --key-provider ${LEGACY_KEY_PROVIDER}`);
    await deps.deploy(true);
    const back = await deps.adoptAndCheck();
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
  for (const name of files) rmSync(join(stateDir, name));
  log(`6/6 removed ${files.join(', ')}; the box's Worker secrets are sealed (${provider})`);
  log('Old copies remain in the bucket and backups: pnpm selfhost:secrets plaintext');
  return 'migrated';
}
