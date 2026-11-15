/**
 * Time-balanced shard plan for the Worker and Durable Object suite.
 *
 * Vitest's own `--shard` sorts files by path hash and cuts equal file counts, so one
 * shard of this suite ran 586 s and another 1,087 s in the same CI run. The suite runs
 * one file at a time per shard (`fileParallelism: false`), so a shard's wall time is
 * the sum of its files' times. This plan assigns files longest first to the shard with
 * the least time so far, using per-file times measured in CI by `timing-reporter.ts`.
 *
 * The plan is deterministic: every shard computes the same plan from the same file
 * list, so each file runs in exactly one shard. Files without a measurement get the
 * median of the measured ones.
 */
import { readFileSync } from 'node:fs';

export interface WorkerShardTimings {
  /** Where the measurements came from, for the next person who refreshes them. */
  source: string;
  /**
   * Time added to shard 1 before any file is assigned. `run-workers-tests.mjs` runs the
   * native SAM runtime suite (`vitest.sam-runtime.config.ts`) on shard 1 only.
   */
  shardOneExtraMs: number;
  /** Median per-file time in ms (setup + collect + tests and hooks), keyed by path from apps/api. */
  files: Record<string, number>;
}

export const SHARD_TIMINGS_URL = new URL('../shard-timings.json', import.meta.url);

export function loadShardTimings(url: URL = SHARD_TIMINGS_URL): WorkerShardTimings {
  return JSON.parse(readFileSync(url, 'utf8')) as WorkerShardTimings;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface ShardPlan {
  shards: string[][];
  /** Predicted time per shard in ms, including `shardOneExtraMs` on shard 1. */
  predictedMs: number[];
}

export function planShards(
  files: readonly string[],
  count: number,
  timings: WorkerShardTimings
): ShardPlan {
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid shard count ${count}`);
  const unique = [...new Set(files)];
  const fallback =
    median(unique.flatMap((file) => (file in timings.files ? [timings.files[file]!] : []))) ?? 1;
  const weighted = unique
    .map((file) => ({ file, weight: timings.files[file] ?? fallback }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));

  const shards: string[][] = Array.from({ length: count }, () => []);
  const predictedMs = Array.from({ length: count }, (_, i) =>
    i === 0 ? timings.shardOneExtraMs : 0
  );
  for (const { file, weight } of weighted) {
    let target = 0;
    for (let i = 1; i < count; i++) if (predictedMs[i]! < predictedMs[target]!) target = i;
    shards[target]!.push(file);
    predictedMs[target]! += weight;
  }
  for (const shard of shards) shard.sort((a, b) => a.localeCompare(b));
  return { shards, predictedMs };
}
