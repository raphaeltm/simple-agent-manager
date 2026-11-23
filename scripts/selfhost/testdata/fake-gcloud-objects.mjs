#!/usr/bin/env node
// Fake `gcloud storage` object calls (bucket-objects.ts) for replaceable-box.test.ts:
// gs://<path> maps to $FAKE_GCS_ROOT/<path>. ls --long, cat, cp <file> <url>, rm <url>...
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.env.FAKE_GCS_ROOT;
const args = process.argv.slice(2);
const path = (url) => join(root, url.replace(/^gs:\/\//, ''));
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]
  );
}
if (args[0] !== 'storage') process.exit(2);
const [, verb, ...rest] = args;
if (verb === 'ls') {
  // `<root>/<prefix>**`: every object whose key starts with the prefix.
  const pattern = rest.find((a) => a.startsWith('gs://')).replace(/\*\*$/, '');
  const slash = pattern.lastIndexOf('/');
  const dirUrl = pattern.slice(0, slash);
  const matched = files(path(dirUrl))
    .map((f) => `${dirUrl}/${f}`)
    .filter((url) => url.startsWith(pattern));
  if (matched.length === 0) {
    process.stderr.write('ERROR: (gcloud.storage.ls) One or more URLs matched no objects.\n');
    process.exit(1);
  }
  for (const url of matched) {
    process.stdout.write(`${statSync(path(url)).size}  2026-11-23T00:00:00Z  ${url}\n`);
  }
  process.exit(0);
}
if (verb === 'cat') {
  if (!existsSync(path(rest[0]))) process.exit(1);
  process.stdout.write(readFileSync(path(rest[0])));
  process.exit(0);
}
if (verb === 'cp') {
  mkdirSync(dirname(path(rest[1])), { recursive: true });
  cpSync(rest[0], path(rest[1]));
  process.exit(0);
}
if (verb === 'rm') {
  for (const url of rest) {
    if (!existsSync(path(url))) process.exit(1);
    rmSync(path(url));
  }
  process.exit(0);
}
process.exit(2);
