#!/usr/bin/env node
// Fake `gcloud storage` for backup-entrypoint.test.ts. gs://<path> maps to $FAKE_GCS_ROOT/<path>.
// It models what the box showed (PR #2675): while celld runs, objects in $FAKE_STATE/churn.json
// vanish mid-copy (404) and the aborted download leaves a tracker keyed by its destination path;
// a later download to that same path fails with `[Errno 2] No such file or directory`.
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.env.FAKE_GCS_ROOT;
const state = process.env.FAKE_STATE;
const args = process.argv.slice(2);
appendFileSync(join(state, 'calls.log'), `gcloud ${args.join(' ')}\n`);

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]
  );
}
const gs = (url) => join(root, url.replace(/^gs:\/\//, '').replace(/\/\*\*$/, ''));
const trackersFile = join(state, 'trackers.json');
const trackers = existsSync(trackersFile) ? JSON.parse(readFileSync(trackersFile, 'utf8')) : [];
const celldRunning = readFileSync(join(state, 'celld'), 'utf8').trim() === 'running';
const churn = existsSync(join(state, 'churn.json'))
  ? JSON.parse(readFileSync(join(state, 'churn.json'), 'utf8'))
  : [];

if (args[0] !== 'storage') process.exit(2);
if (args[1] === 'ls') {
  const listed = files(gs(args[2]));
  if (listed.length === 0) {
    process.stderr.write('ERROR: (gcloud.storage.ls) One or more URLs matched no objects.\n');
    process.exit(1);
  }
  process.stdout.write(
    listed.map((f) => `${args[2].replace(/\/\*\*$/, '')}/${f}`).join('\n') + '\n'
  );
  process.exit(0);
}
if (args[1] !== 'rsync') process.exit(2);
const [src, dst] = args.slice(-2);
const mirror = args.includes('--delete-unmatched-destination-objects');
if (!src.startsWith('gs://')) {
  // backup -> bucket
  for (const f of files(src)) {
    mkdirSync(dirname(join(gs(dst), f)), { recursive: true });
    cpSync(join(src, f), join(gs(dst), f));
  }
  process.exit(0);
}
const source = files(gs(src));
mkdirSync(dst, { recursive: true });
if (mirror) for (const f of files(dst)) if (!source.includes(f)) rmSync(join(dst, f));
const errors = [];
for (const f of source) {
  const target = join(dst, f);
  if (celldRunning && churn.includes(f)) {
    // celld replaced this generation mid-copy: the download aborts and leaves its tracker
    trackers.push(target);
    errors.push(`ERROR: ${src}/${f}#1 not found: 404.`);
    continue;
  }
  if (trackers.includes(target) && !existsSync(`${target}_.gstmp`)) {
    errors.push(`ERROR: [Errno 2] No such file or directory: '${target}'`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(gs(src), f), target);
}
writeFileSync(trackersFile, JSON.stringify(trackers));
if (errors.length) {
  process.stderr.write(`Copying...\n${errors.join('\n')}\n`);
  process.exit(1);
}
