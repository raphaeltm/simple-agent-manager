#!/usr/bin/env node
// Fake `docker compose ... stop|start celld` for backup-entrypoint.test.ts. Stopping celld applies
// $FAKE_STATE/on-stop.json once: the writes celld made between the live pass and its shutdown.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const state = process.env.FAKE_STATE;
const args = process.argv.slice(2);
appendFileSync(join(state, 'calls.log'), `docker ${args.join(' ')}\n`);
if (args[0] !== 'compose') process.exit(2);
const [action, service] = args.slice(-2);
if (service !== 'celld') process.exit(2);
writeFileSync(join(state, 'celld'), action === 'stop' ? 'stopped' : 'running');
const onStop = join(state, 'on-stop.json');
if (action === 'stop' && existsSync(onStop)) {
  const { bucketDir, remove, write } = JSON.parse(readFileSync(onStop, 'utf8'));
  for (const f of remove) rmSync(join(bucketDir, f));
  for (const [f, body] of Object.entries(write)) {
    mkdirSync(dirname(join(bucketDir, f)), { recursive: true });
    writeFileSync(join(bucketDir, f), body);
  }
  rmSync(onStop);
}
