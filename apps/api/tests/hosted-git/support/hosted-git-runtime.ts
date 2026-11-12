/**
 * Runs the hosted git test Worker as native workerd modules in Miniflare, listening on a local
 * port, so the real `git` CLI can clone from and push to it. Real D1 (all migrations applied)
 * and real Durable Object SQLite. Same approach as tests/workers/support/sam-native-runtime.ts.
 */
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { readD1Migrations } from '@cloudflare/vitest-pool-workers';

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve('wrangler/package.json');
const wranglerBin = resolve(dirname(wranglerPackage), require(wranglerPackage).bin.wrangler);
const execute = promisify(execFile);
const { Miniflare } = createRequire(import.meta.resolve('@cloudflare/vitest-pool-workers'))(
  'miniflare'
);

export const HOSTED_GIT_TEST_BASE_DOMAIN = 'sam.test.example';

export interface HostedGitRuntime {
  /** e.g. http://127.0.0.1:41234 */
  origin: string;
  DATABASE: D1Database;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** Handles the Worker's outbound fetches (e.g. an import from a fake public forge). */
export type OutboundHandler = (request: Request) => Promise<Response>;

export async function startHostedGitRuntime(
  outbound: OutboundHandler = async () => new Response('no outbound in tests', { status: 502 })
): Promise<HostedGitRuntime> {
  const directory = await mkdtemp(resolve(tmpdir(), 'sam-hosted-git-'));
  const root = resolve(import.meta.dirname, '../../..');
  const bundleDirectory = resolve(directory, 'bundle');
  const configPath = resolve(directory, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'sam-hosted-git-test',
      main: resolve(root, 'tests/hosted-git/support/hosted-git-entry.ts'),
      compatibility_date: '2026-01-01',
      compatibility_flags: ['nodejs_compat'],
      alias: { 'unicorn-magic': resolve(root, 'src/shims/unicorn-magic.ts') },
    })
  );
  await execute(
    process.execPath,
    [wranglerBin, 'deploy', '--dry-run', '--config', configPath, '--outdir', bundleDirectory],
    {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 4_000_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    }
  );
  const files = await readdir(bundleDirectory);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const runtime = new Miniflare({
    modulesRoot: bundleDirectory,
    modules: [
      { type: 'ESModule', path: resolve(bundleDirectory, 'hosted-git-entry.js') },
      ...files
        .filter((name) => name.endsWith('.wasm'))
        .map((name) => ({ type: 'CompiledWasm', path: resolve(bundleDirectory, name) })),
    ],
    compatibilityDate: '2026-01-01',
    compatibilityFlags: ['nodejs_compat'],
    host: '127.0.0.1',
    port: 0,
    durableObjects: { HOSTED_GIT: { className: 'HostedGitRepo', useSQLite: true } },
    d1Databases: ['DATABASE', 'OBSERVABILITY_DATABASE'],
    kvNamespaces: ['KV'],
    outboundService: (request: Request) => outbound(request),
    bindings: {
      BASE_DOMAIN: HOSTED_GIT_TEST_BASE_DOMAIN,
      ENCRYPTION_KEY: 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=',
      ARTIFACTS_ENABLED: 'true',
      HOSTED_GIT_BACKEND: 'durable-object',
      JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  });
  const cleanup = async () => {
    await runtime.dispose().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const url: URL = await runtime.ready;
    const database = (await runtime.getD1Database('DATABASE')) as D1Database;
    for (const migration of await readD1Migrations(resolve(root, 'src/db/migrations'))) {
      await database.batch(migration.queries.map((query) => database.prepare(query)));
    }
    const origin = url.origin;
    return {
      origin,
      DATABASE: database,
      fetch: (path, init) => fetch(`${origin}${path}`, init),
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
