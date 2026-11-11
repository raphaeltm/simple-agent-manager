#!/usr/bin/env tsx
/**
 * Create a SAM account on a deployed celld box, so that address can sign in with an emailed code.
 *
 *   pnpm selfhost:create-account --email someone@example.com [--superadmin]
 *                                [--env-file deploy/selfhost/.env] [--state-dir <env dir>/.state]
 *                                [--dry-run]
 *
 * For an install whose first-account path is already used (a seeded smoke-test superadmin, or an
 * owner who signed up): email sign-in sends codes only to existing accounts, so a new person needs
 * an account first. Idempotent: an existing account is left as it is, except that --superadmin
 * promotes it. Writes the `users` table BetterAuth reads (account-sql.ts) through
 * `celld d1 execute`, so the stack must be running and deployed (`pnpm selfhost:deploy`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createAccountSql, generateAccountId, normalizeAccountEmail } from './account-sql.js';
import { celldChildEnv, redactSecrets } from './box-settings.js';
import { ensureCelldBinary, resolveEsbuild } from './celld-binary.js';
import { assertPrivateFile, parseDotenv, readSecretsFile } from './secret-files.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
/** Upper bound on captured celld output. */
const CHILD_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

function log(message: string): void {
  console.log(`[selfhost] ${message}`);
}

/** The D1 database bound as DATABASE in the deployed (secrets-free) celld config. */
export function mainDatabaseName(wranglerJson: string): string {
  const config: unknown = JSON.parse(wranglerJson);
  const databases =
    config && typeof config === 'object' && 'd1_databases' in config ? config.d1_databases : null;
  if (Array.isArray(databases)) {
    for (const entry of databases as unknown[]) {
      if (entry && typeof entry === 'object' && 'binding' in entry && 'database_name' in entry) {
        if (entry.binding === 'DATABASE' && typeof entry.database_name === 'string') {
          return entry.database_name;
        }
      }
    }
  }
  throw new Error('the deployed config has no DATABASE binding; run pnpm selfhost:deploy first');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      superadmin: { type: 'boolean', default: false },
      'env-file': { type: 'string' },
      'state-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.email) throw new Error('--email is required');
  const email = normalizeAccountEmail(values.email);
  const sql = createAccountSql({
    email,
    superadmin: values.superadmin ?? false,
    id: generateAccountId(),
    nowMs: Date.now(),
  });
  if (values['dry-run']) {
    console.log(sql);
    return;
  }

  const envFile = resolve(values['env-file'] ?? join(REPO_ROOT, 'deploy/selfhost/.env'));
  assertPrivateFile(envFile);
  const box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
  if (!box.CELLD_BUCKET) throw new Error(`${envFile}: CELLD_BUCKET is required`);
  const stateDir = resolve(
    dirname(envFile),
    values['state-dir'] ?? box.SAM_SELFHOST_STATE_DIR ?? '.state'
  );
  const projectDir = join(stateDir, 'project');
  const configPath = join(projectDir, 'wrangler.json');
  if (!existsSync(configPath)) throw new Error(`${configPath} not found; run pnpm selfhost:deploy`);
  const database = mainDatabaseName(readFileSync(configPath, 'utf8'));

  const celld = await ensureCelldBinary(join(stateDir, 'bin'));
  const env = celldChildEnv(process.env, box, resolveEsbuild(join(REPO_ROOT, 'apps/api')));
  log(`${values.superadmin ? 'creating or promoting' : 'creating'} the account for ${email}`);
  const result = spawnSync(
    celld,
    ['d1', 'execute', database, '--command', sql, projectDir, '--bucket', box.CELLD_BUCKET],
    { cwd: REPO_ROOT, env, encoding: 'utf8', maxBuffer: CHILD_OUTPUT_MAX_BYTES }
  );
  const secrets = [box.AWS_SECRET_ACCESS_KEY ?? ''].filter(Boolean);
  process.stdout.write(redactSecrets(`${result.stdout ?? ''}${result.stderr ?? ''}`, secrets));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`celld d1 execute failed (exit ${result.status})`);
  // The last statement reports the account; no row means nothing usable was written.
  if (!result.stdout?.includes(email)) {
    throw new Error(`no account for ${email} after the command; nothing was created`);
  }
  if (/\bsuspended\b/.test(result.stdout)) {
    log(`note: ${email} is suspended; an administrator must reactivate it in Admin → Users`);
  }
  log(`done: ${email} can now request a sign-in code at https://app.${box.SAM_DOMAIN ?? ''}`);
  // Until the installer owner has signed in once, SAM admits no one else (bootstrap-owner.ts).
  const owner = readSecretsFile(join(stateDir, 'secrets.env')).BOOTSTRAP_OWNER_EMAIL?.trim();
  if (owner && owner.toLowerCase() !== email) {
    log(`note: BOOTSTRAP_OWNER_EMAIL is set; if ${owner} has not signed in yet, only they can`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
