/**
 * `pnpm selfhost:rebuild [--installation-id <id>] [--allow-no-head] [--env-file <path>] [--state-dir <dir>]`
 *
 * Replaces a dead replaceable box (README "Replace a dead box"): on a new VM with this checkout,
 * the dead box's `.env` and an EMPTY state directory, it copies the box's sealed bundles and
 * cloud record back from the fleet bucket (replaceable-rebuild.ts). Then run
 * `pnpm selfhost:deploy --init`, start Docker Compose and `pnpm selfhost:deploy` as on a fresh
 * install: the same installation and keys come back. Prints ids and paths only, never a secret.
 */
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { log, SELFHOST_DIR } from './backup-cli';
import { loadBoxEnv } from './box-settings';
import { detectKeyCandidates } from './key-platforms';
import { assertOperatorExecution } from './operator-only';
import { fleetBucket } from './replaceable-box';
import { runRebuild } from './replaceable-rebuild';
import { assertPrivateFile } from './secret-files';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    'state-dir': { type: 'string' },
    'installation-id': { type: 'string' },
    'allow-no-head': { type: 'boolean' },
  },
});
assertOperatorExecution();
const envFile = resolve(values['env-file'] ?? join(SELFHOST_DIR, '.env'));
// It holds the bucket credential (or names the box's identity's bucket): it must stay private.
assertPrivateFile(envFile);
const box = loadBoxEnv(envFile, SELFHOST_DIR);
const stateDir = resolve(
  dirname(envFile),
  values['state-dir'] ?? box.SAM_SELFHOST_STATE_DIR ?? '.state'
);
const started = Date.now();
const result = await runRebuild({
  box,
  stateDir,
  bucket: fleetBucket(box),
  detect: detectKeyCandidates,
  log,
  expectedInstallationId: values['installation-id'],
  allowNoHead: values['allow-no-head'] === true,
});
log(
  `rebuilt the sealed state of installation ${result.installationId} in ${Math.round((Date.now() - started) / 1000)} s. Next:`
);
log(
  `  pnpm selfhost:deploy --init --env-file '${envFile.replaceAll("'", "'\"'\"'")}'   (keeps these keys; prints COMPOSE_PROJECT_NAME and SAM_KEY_AGENT_UID)`
);
const composeEnv = `--env-file '${envFile.replaceAll("'", "'\"'\"'")}'`;
log(
  `  (cd deploy/selfhost && docker compose ${composeEnv} build && docker compose ${composeEnv} up -d)`
);
log(`  pnpm selfhost:deploy --env-file '${envFile.replaceAll("'", "'\"'\"'")}'`);
