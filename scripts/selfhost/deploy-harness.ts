/**
 * Test harness: runs the real `pnpm selfhost:deploy` entry (deploy.ts) as a child process on a
 * throwaway `.env`, exactly as an operator does.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BOX_RESERVED_PORTS } from './box-settings.js';
import { composeFileVariables } from './compose-env.js';
import { SELFHOST_DIR } from './deploy-steps.js';

const DEPLOY = resolve(import.meta.dirname, 'deploy.ts');
/** The repository's own tsx, not `npx tsx` (npx resolution costs seconds under load). */
const TSX = resolve(import.meta.dirname, '../../node_modules/.bin/tsx');
/** Per-test timeout for files that start these child processes. */
export const CHILD_TEST_TIMEOUT_MS = 120_000;

/** A closed local port: a metadata probe or key service there fails at once. */
export const CLOSED_HOST = '127.0.0.1:9';

const BASE_BOX_ENV = [
  // Sealed secrets are the default: the key agent's uid (the deploying user), and no cloud
  // metadata service, so `--init` chooses the key file without asking a real cloud.
  `SAM_KEY_AGENT_UID=${process.getuid?.() ?? 0}`,
  `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
  `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
  `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
  'SAM_DOMAIN=sam.example.com',
  'SAM_TLS_MODE=internal',
  'COMPOSE_PROFILES=tunnel,local-store',
  'CELLD_BUCKET=s3://fleet/celld',
  'S3_ENDPOINT=http://127.0.0.1:9000',
  'AWS_ACCESS_KEY_ID=fleet-key',
  'AWS_SECRET_ACCESS_KEY=fleet-secret-0123456789abcdef',
];

/**
 * A `docker` on PATH for a deploy that finds an existing install (a second `--init`, a deploy
 * after one): `compose ps` answers "nothing running", anything else fails the test. Returns the
 * env to pass to runDeploy.
 */
export function noStackDocker(dir: string): NodeJS.ProcessEnv {
  const bin = join(dir, 'no-stack-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'docker'),
    '#!/usr/bin/env node\nif (process.argv.includes("ps")) process.stdout.write("[]");\nelse process.exit(90);\n',
    { mode: 0o755 }
  );
  return { PATH: `${bin}:${process.env.PATH}` };
}

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
    // The deploy honours a shell value for every variable compose interpolates, as docker compose
    // does (withComposeShellOverrides), so the test runner's own environment must not leak any:
    // only `env` sets them.
    const inherited = { ...process.env };
    const composeNames = [
      ...composeFileVariables({}, SELFHOST_DIR),
      ...Object.keys(BOX_RESERVED_PORTS),
    ];
    for (const name of composeNames) delete inherited[name];
    const child = spawn(
      TSX,
      ['--tsconfig', resolve(import.meta.dirname, 'tsconfig.json'), script, ...args],
      { env: { ...inherited, ...env } }
    );
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
