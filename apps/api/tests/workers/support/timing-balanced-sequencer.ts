import { relative, sep } from 'node:path';

import { BaseSequencer, type TestSpecification } from 'vitest/node';

import { loadShardTimings, planShards } from './shard-plan';

/**
 * Splits `--shard=i/n` by measured file time instead of by path hash (see shard-plan.ts).
 * Ordering inside a shard is left to the base sequencer.
 */
export default class TimingBalancedSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { shard, root } = this.ctx.config;
    if (!shard) return Promise.resolve(files);
    const byPath = new Map<string, TestSpecification[]>();
    for (const spec of files) {
      const path = relative(root, spec.moduleId).split(sep).join('/');
      byPath.set(path, [...(byPath.get(path) ?? []), spec]);
    }
    const plan = planShards([...byPath.keys()], shard.count, loadShardTimings());
    return Promise.resolve(plan.shards[shard.index - 1]!.flatMap((path) => byPath.get(path)!));
  }
}
