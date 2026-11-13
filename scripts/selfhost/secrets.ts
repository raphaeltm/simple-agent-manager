/**
 * `pnpm selfhost:secrets <command> [--box-env <path>] [--state-dir <dir>]`
 *
 *   status                    which key provider seals the Worker secrets, why, and the bundles
 *   key-file                  where the file key is, its fingerprint and mode
 *   verify-key-copy <path>    whether a copy of the file key matches the box's (exit 1 if not)
 *   migrate [--key-copy <path>]
 *                             move a plaintext install to sealed secrets (secrets-migrate.ts),
 *                             rolling back on failure; removes the plaintext files at the end
 *   switch --to <provider|auto> [--dry-run]
 *                             seal again with another key provider and move the box over
 *   reseal                    seal again with the same provider (new data key, current KEK)
 *   plaintext [--backups DIR|gs://...|s3://... ...] [--purge --confirm <CELLD_BUCKET> [--min-age-hours N]]
 *                             old deploy versions and backups holding plaintext secrets, what to
 *                             rotate; with --purge, delete the versions celld no longer reads
 *   rotate --all | <key> ... [--dry-run] [--skip-backup] [--jwt-overlap-hours N]
 *          [--stored-lifetime-minutes N]
 *   rotate --resume | --status
 *                             replace platform keys (rotate-run.ts); --dry-run prints the plan
 *                             and what users notice per key
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
  scanRemoteBackups,
} from './plaintext-scan';
import { boxRotateDeps } from './rotate-box-deps';
import { formatSummary } from './rotate-report';
import { runRotate } from './rotate-run';
import { readJournal } from './rotate-store';
import { assertPrivateFile, parseDotenv } from './secret-files';
import { boxMigrateDeps, boxSwitchDeps } from './secrets-box-deps';
import { describeKeyFile, verifyKeyCopy } from './secrets-keyfile';
import { runMigration } from './secrets-migrate';
import { describeKeyStatus } from './secrets-status';
import { runSwitch } from './secrets-switch';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
    backups: { type: 'string', multiple: true },
    purge: { type: 'boolean', default: false },
    confirm: { type: 'string' },
    'min-age-hours': { type: 'string' },
    'key-copy': { type: 'string' },
    to: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    'skip-backup': { type: 'boolean', default: false },
    'jwt-overlap-hours': { type: 'string' },
    'stored-lifetime-minutes': { type: 'string' },
  },
});

function positiveNumber(
  value: string | undefined,
  flag: string,
  allowZero = false
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) {
    throw new Error(`${flag} must be a ${allowZero ? 'non-negative' : 'positive'} number`);
  }
  return n;
}
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
    case 'switch':
    case 'reseal': {
      if (command === 'switch' && !values.to) {
        throw new Error(
          'usage: pnpm selfhost:secrets switch --to <file|gcp-kms|aws-kms|azure-kv|transit|auto>'
        );
      }
      const ctx = loadBox(envFile, values['state-dir']);
      await runSwitch(
        {
          box,
          stateDir,
          to: command === 'reseal' ? null : (values.to ?? null),
          dryRun: values['dry-run'],
        },
        boxSwitchDeps(ctx)
      );
      break;
    }
    case 'plaintext': {
      const ctx = loadBox(envFile, values['state-dir']);
      const secrets = await knownSecrets(box, stateDir);
      const locations = values.backups?.length ? values.backups : [join(SELFHOST_DIR, 'backups')];
      const backups = locations.flatMap((location) =>
        /^(gs|s3):\/\//.test(location)
          ? scanRemoteBackups(ctx, location, secrets)
          : scanBackups(resolve(process.env.INIT_CWD ?? process.cwd(), location), secrets)
      );
      if (values.purge) {
        const hours =
          values['min-age-hours'] === undefined ? undefined : Number(values['min-age-hours']);
        if (hours !== undefined && !(Number.isFinite(hours) && hours >= 0)) {
          throw new Error('--min-age-hours must be a number of hours (0 or more)');
        }
        const result = purgeVersions(ctx, secrets, values.confirm, {
          minAgeMs: hours === undefined ? undefined : hours * 3600_000,
        });
        for (const prefix of result.deleted) console.log(`deleted ${prefix}`);
        for (const line of result.skipped) console.log(`kept ${line}`);
      }
      const lines = formatPlaintextReport(
        box.CELLD_BUCKET ?? '',
        scanDeployVersions(ctx, secrets),
        backups,
        locations.join(', ')
      );
      for (const line of lines) console.log(line);
      break;
    }
    case 'rotate': {
      if (values.status) {
        const journal = readJournal(stateDir);
        if (!journal) {
          console.log('no rotation in progress');
          break;
        }
        for (const line of formatSummary(journal, {}, stateDir)) console.log(line);
        break;
      }
      const ctx = loadBox(envFile, values['state-dir']);
      await runRotate(
        {
          box,
          stateDir,
          names: positionals.slice(1),
          all: values.all,
          dryRun: values['dry-run'],
          resume: values.resume,
          skipBackup: values['skip-backup'],
          jwtOverlapHours: positiveNumber(values['jwt-overlap-hours'], '--jwt-overlap-hours', true),
          storedLifetimeMinutes: positiveNumber(
            values['stored-lifetime-minutes'],
            '--stored-lifetime-minutes'
          ),
        },
        boxRotateDeps(ctx)
      );
      break;
    }
    default:
      throw new Error(
        'usage: pnpm selfhost:secrets status|key-file|verify-key-copy <path>|migrate|switch|reseal|plaintext|rotate [--box-env PATH] [--state-dir DIR]'
      );
  }
} catch (error) {
  console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
