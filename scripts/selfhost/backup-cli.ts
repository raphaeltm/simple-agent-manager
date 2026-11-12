/**
 * Shared CLI plumbing for `pnpm selfhost:backup` and `pnpm selfhost:restore` (backup-lib.ts).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { BoxContext, RunResult } from './backup-lib';
import { assertPrivateFile, parseDotenv } from './secret-files';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
export const SELFHOST_DIR = join(REPO_ROOT, 'deploy/selfhost');

export function log(message: string): void {
  process.stdout.write(`[selfhost] ${message}\n`);
}

export function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function gitCommit(): string | null {
  const result = runCommand('git', ['rev-parse', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The box context from an .env file (which must exist and be private: it holds the bucket key). */
export function loadBox(envFile: string, stateDirOverride?: string): BoxContext {
  if (!existsSync(envFile)) throw new Error(`${envFile} does not exist`);
  assertPrivateFile(envFile);
  const box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
  if (!box.CELLD_BUCKET) throw new Error(`${envFile}: CELLD_BUCKET is required`);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return {
    box,
    envFile,
    // Same default and base directory docker compose and deploy.ts use.
    stateDir: resolve(dirname(envFile), stateDirOverride ?? box.SAM_SELFHOST_STATE_DIR ?? '.state'),
    composeFile: join(SELFHOST_DIR, 'docker-compose.yml'),
    run: runCommand,
    now: () => Date.now(),
    log,
    user: uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined,
  };
}
