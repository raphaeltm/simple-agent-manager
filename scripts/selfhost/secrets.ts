/**
 * `pnpm selfhost:secrets <command> [--box-env <path>] [--state-dir <dir>]`
 *
 *   status                    which key provider seals the Worker secrets, why, and the bundles
 *   key-file                  where the file key is, its fingerprint and mode
 *   verify-key-copy <path>    whether a copy of the file key matches the box's (exit 1 if not)
 *   migrate [--key-copy <path>]
 *                             move a plaintext install to sealed secrets (secrets-migrate.ts),
 *                             rolling back on failure; removes the plaintext files at the end
 *   plaintext [--backups DIR] [--purge --confirm <CELLD_BUCKET>]
 *                             old deploy versions and backups holding plaintext secrets, what to
 *                             rotate; with --purge, delete the versions celld no longer reads
 *
 * Every command prints names, paths, fingerprints and ids only: never a key or a secret value.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadBox, SELFHOST_DIR } from './backup-cli';
import {
  formatPlaintextReport,
  knownSecrets,
  purgeVersions,
  scanBackups,
  scanDeployVersions,
} from './plaintext-scan';
import { assertPrivateFile, parseDotenv } from './secret-files';
import { boxMigrateDeps } from './secrets-box-deps';
import { describeKeyFile, verifyKeyCopy } from './secrets-keyfile';
import { runMigration } from './secrets-migrate';
import { describeKeyStatus } from './secrets-status';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
    backups: { type: 'string' },
    purge: { type: 'boolean', default: false },
    confirm: { type: 'string' },
    'key-copy': { type: 'string' },
  },
});
const envFile = resolve(values['box-env'] ?? join(SELFHOST_DIR, '.env'));
assertPrivateFile(envFile);
const box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
const stateDir = resolve(
  dirname(envFile),
  values['state-dir'] ?? box.SAM_SELFHOST_STATE_DIR ?? '.state'
);

const [command, argument] = positionals;
try {
  switch (command) {
    case 'status':
      for (const line of describeKeyStatus(box, stateDir)) console.log(line);
      break;
    case 'key-file':
      for (const line of describeKeyFile(stateDir)) console.log(line);
      break;
    case 'verify-key-copy': {
      if (!argument) throw new Error('usage: pnpm selfhost:secrets verify-key-copy <path to copy>');
      // pnpm runs scripts from the repository root; INIT_CWD is where the operator typed the command.
      const result = verifyKeyCopy(
        stateDir,
        resolve(process.env.INIT_CWD ?? process.cwd(), argument)
      );
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'migrate': {
      const ctx = loadBox(envFile, values['state-dir']);
      const keyCopy = values['key-copy'];
      await runMigration(
        {
          box,
          stateDir,
          keyCopy: keyCopy ? resolve(process.env.INIT_CWD ?? process.cwd(), keyCopy) : undefined,
        },
        boxMigrateDeps(ctx)
      );
      break;
    }
    case 'plaintext': {
      const ctx = loadBox(envFile, values['state-dir']);
      const secrets = await knownSecrets(box, stateDir);
      const backupsRoot = resolve(
        process.env.INIT_CWD ?? process.cwd(),
        values.backups ?? join(SELFHOST_DIR, 'backups')
      );
      if (values.purge) {
        const result = purgeVersions(ctx, secrets, values.confirm);
        for (const prefix of result.deleted) console.log(`deleted ${prefix}`);
        for (const line of result.skipped) console.log(`kept ${line}`);
      }
      const lines = formatPlaintextReport(
        box.CELLD_BUCKET ?? '',
        scanDeployVersions(ctx, secrets),
        scanBackups(backupsRoot, secrets),
        backupsRoot
      );
      for (const line of lines) console.log(line);
      break;
    }
    default:
      throw new Error(
        'usage: pnpm selfhost:secrets status|key-file|verify-key-copy <path>|migrate|plaintext [--box-env PATH] [--state-dir DIR]'
      );
  }
} catch (error) {
  console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
