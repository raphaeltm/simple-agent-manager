/**
 * Refreshes tests/workers/shard-timings.json from CI timing artifacts.
 *
 *   gh run download <run-id> -p 'workers-timings-*' -D /tmp/timings/<run-id>   # several runs
 *   pnpm --filter @simple-agent-manager/api exec tsx \
 *     tests/workers/support/update-shard-timings.ts "<source note>" /tmp/timings/** /workers-timing.json
 *
 * Each file's time is the median over every artifact that ran it, so one slow runner
 * does not skew the plan. `shardOneExtraMs` is kept from the current file.
 */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';

import { loadShardTimings, SHARD_TIMINGS_URL, type WorkerShardTimings } from './shard-plan';

interface ReporterEntry {
  file: string;
  setupMs: number;
  collectMs: number;
  testsAndHooksMs: number;
}

const [source, ...artifacts] = process.argv.slice(2);
if (!source || artifacts.length === 0) {
  console.error('usage: update-shard-timings.ts "<source note>" <workers-timing.json>...');
  process.exit(2);
}

const samples = new Map<string, number[]>();
for (const artifact of artifacts) {
  for (const entry of JSON.parse(readFileSync(artifact, 'utf8')) as ReporterEntry[]) {
    const total = entry.setupMs + entry.collectMs + entry.testsAndHooksMs;
    samples.set(entry.file, [...(samples.get(entry.file) ?? []), total]);
  }
}

const files = Object.fromEntries(
  [...samples]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      // Rounded to 0.1 s so a refresh does not rewrite every line for noise.
      return [file, Math.round(sorted[Math.floor(sorted.length / 2)]! / 100) * 100];
    })
);

const next: WorkerShardTimings = {
  source,
  shardOneExtraMs: loadShardTimings().shardOneExtraMs,
  files,
};
writeFileSync(SHARD_TIMINGS_URL, `${JSON.stringify(next, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length} files from ${artifacts.length} artifacts`);
