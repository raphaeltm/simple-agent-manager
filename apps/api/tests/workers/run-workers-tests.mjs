import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const args = process.argv.slice(2);
const shardOption = args.find((arg) => arg.startsWith('--shard='));
const shardIndex = args.indexOf('--shard');
const shard =
  shardOption?.slice('--shard='.length) ?? (shardIndex >= 0 ? args[shardIndex + 1] : undefined);

function run(config, options = []) {
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', config, ...options], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Preserve the established Workers pool, shard, file filters and timing reporter.
run('vitest.workers.config.ts', args);
// Native module suites run once in CI; they do not overwrite shard timing output.
if (!shard || shard.startsWith('1/')) run('vitest.sam-runtime.config.ts');
