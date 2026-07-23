import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
export type WorkerTestShard = 'durable-objects' | 'http';
const ROOT = resolve(import.meta.dirname);
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
export function discoverWorkerTestFiles(): string[] {
  return walk(ROOT)
    .filter((path) => path.endsWith('.test.ts'))
    .map((path) => relative(resolve(ROOT, '../..'), path).split(sep).join('/'))
    .sort();
}
export function workerTestShard(file: string): WorkerTestShard {
  const source = readFileSync(resolve(ROOT, file.replace(/^tests\/workers\//, '')), 'utf8');
  return /import\s*\{[^}]*\bSELF\b[^}]*\}\s*from\s*['"]cloudflare:test['"]/.test(source)
    ? 'http'
    : 'durable-objects';
}
export function workerTestsForShard(shard: WorkerTestShard): string[] {
  return discoverWorkerTestFiles().filter((file) => workerTestShard(file) === shard);
}
