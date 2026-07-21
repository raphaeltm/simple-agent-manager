import {
  discoverWorkerTestFiles,
  workerTestsForShard,
  type WorkerTestShard,
} from '../tests/workers/worker-test-shards';
const shards: WorkerTestShard[] = ['durable-objects', 'http'];
const inventory = discoverWorkerTestFiles();
const owned = shards.flatMap((shard) => workerTestsForShard(shard));
const failures = inventory.filter(
  (file) => owned.filter((candidate) => candidate === file).length !== 1
);
if (!inventory.length || failures.length || owned.some((file) => !inventory.includes(file))) {
  console.error({ inventory: inventory.length, failures });
  process.exitCode = 1;
} else {
  for (const shard of shards) console.log(`${shard}: ${workerTestsForShard(shard).length} files`);
  console.log(`total: ${inventory.length} files, each owned exactly once`);
}
