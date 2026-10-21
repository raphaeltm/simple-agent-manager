import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Resolve the versions already pinned by the toolchain; no generated bundle is committed.
const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve('wrangler/package.json');
const wranglerBin = resolve(dirname(wranglerPackage), require(wranglerPackage).bin.wrangler);
const execute = promisify(execFile);
const { Miniflare } = createRequire(import.meta.resolve('@cloudflare/vitest-pool-workers'))(
  'miniflare'
);

export type SamRuntimeStub = DurableObjectStub & {
  testSql(query: string, values?: SqlStorageValue[]): Promise<Record<string, SqlStorageValue>[]>;
  testEnvironment(values: Record<string, string>): Promise<void>;
  testAlarm(): Promise<void>;
};

/** Native modules avoid the Workers Vitest dynamic-loader recursion with Mastra. */
export async function startSamRuntime(outbound: (request: Request) => Promise<Response>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'sam-native-runtime-'));
  const root = resolve(import.meta.dirname, '../../..');
  const bundleDirectory = resolve(directory, 'bundle');
  const configPath = resolve(directory, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'sam-native-runtime-test',
      main: resolve(root, 'tests/workers/support/sam-native-entry.ts'),
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
      timeout: 30_000,
      maxBuffer: 2_000_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    }
  );
  const files = await readdir(bundleDirectory);
  const runtime = new Miniflare({
    modulesRoot: bundleDirectory,
    modules: [
      { type: 'ESModule', path: resolve(bundleDirectory, 'sam-native-entry.js') },
      ...files
        .filter((name) => name.endsWith('.wasm'))
        .map((name) => ({
          type: 'CompiledWasm',
          path: resolve(bundleDirectory, name),
        })),
    ],
    compatibilityDate: '2026-01-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { SAM_SESSION: { className: 'SamSessionRuntime', useSQLite: true } },
    d1Databases: ['DATABASE'],
    kvNamespaces: ['KV'],
    bindings: {
      BASE_DOMAIN: 'test.example.com',
      SAM_MODEL: '@cf/google/gemma-4-26b-a4b-it',
      CF_API_TOKEN: 'test-only-fake-token',
      CF_ACCOUNT_ID: 'sam-test-account',
      AI_GATEWAY_ID: 'sam-test-gateway',
    },
    outboundService: outbound,
  });
  try {
    await runtime.ready;
    const database = (await runtime.getD1Database('DATABASE')) as D1Database;
    for (const migration of await readD1Migrations(resolve(root, 'src/db/migrations'))) {
      await database.batch(migration.queries.map((query) => database.prepare(query)));
    }
    const sessions = (await runtime.getDurableObjectNamespace(
      'SAM_SESSION'
    )) as DurableObjectNamespace;
    return {
      DATABASE: database,
      KV: (await runtime.getKVNamespace('KV')) as KVNamespace,
      SAM_SESSION: sessions,
      async close() {
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
