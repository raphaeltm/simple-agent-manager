/**
 * Test harness: runs the real `pnpm selfhost:deploy` entry (deploy.ts) as a child process on a
 * throwaway `.env`, exactly as an operator does.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BOX_RESERVED_PORTS } from './box-settings.js';

const DEPLOY = resolve(import.meta.dirname, 'deploy.ts');
/** The repository's own tsx, not `npx tsx` (npx resolution costs seconds under load). */
const TSX = resolve(import.meta.dirname, '../../node_modules/.bin/tsx');
/** Per-test timeout for files that start these child processes. */
export const CHILD_TEST_TIMEOUT_MS = 120_000;

const BASE_BOX_ENV = [
  'SAM_DOMAIN=sam.example.com',
  'SAM_TLS_MODE=internal',
  'COMPOSE_PROFILES=tunnel,local-store',
  'CELLD_BUCKET=s3://fleet/celld',
  'S3_ENDPOINT=http://127.0.0.1:9000',
  'AWS_ACCESS_KEY_ID=fleet-key',
  'AWS_SECRET_ACCESS_KEY=fleet-secret-0123456789abcdef',
];

export function writeBox(dir: string, extra: string[] = []): string {
  const envFile = join(dir, '.env');
  writeFileSync(envFile, `${[...BASE_BOX_ENV, ...extra].join('\n')}\n`, { mode: 0o600 });
  return envFile;
}

export function runTsx(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{ status: number; out: string }> {
  return new Promise((done, fail) => {
    // The deploy honours shell port overrides as docker compose does (withComposePortOverrides),
    // so the test runner's own environment must not leak any: only `env` sets them.
    const inherited = { ...process.env };
    for (const name of Object.keys(BOX_RESERVED_PORTS)) delete inherited[name];
    const child = spawn(TSX, [script, ...args], { env: { ...inherited, ...env } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ status: code ?? 1, out });
    });
  });
}

export function runDeploy(
  envFile: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{ status: number; out: string }> {
  return runTsx(DEPLOY, ['--env-file', envFile, ...args], env);
}
