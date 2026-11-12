#!/usr/bin/env node
// Fake `docker` for teardown.test.ts: compose stop/down and `volume ls` against $STATE/docker.json
// ({ running, volumes, images }); every call is appended to $STATE/docker-calls.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.STATE;
const args = process.argv.slice(2);
appendFileSync(join(STATE, 'docker-calls'), `${args.join(' ')}\n`);
const file = join(STATE, 'docker.json');
const db = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { running: true, volumes: [], images: true };
const save = () => writeFileSync(file, JSON.stringify(db, null, 2));

if (args[0] === 'volume' && args[1] === 'ls') {
  for (const v of db.volumes) process.stdout.write(`${v}\n`);
} else if (args[0] === 'compose') {
  const action = args.find((a) => ['stop', 'down', 'up', 'start'].includes(a));
  if (action === 'stop' || action === 'down') db.running = false;
  if (action === 'down' && args.includes('-v')) db.volumes = [];
  if (action === 'down' && args.includes('--rmi')) db.images = false;
  if (action === 'up' || action === 'start') db.running = true;
  save();
} else {
  process.stderr.write(`fake docker: unexpected ${args.join(' ')}\n`);
  process.exit(2);
}
