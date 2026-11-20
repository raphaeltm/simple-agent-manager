#!/usr/bin/env node
// The record of cloud resources SAM's setup scripts created for one install, kept in the box
// state (`.state/created-resources.json`, mode 0600) so a teardown removes exactly those and
// nothing else. Provider-neutral: one entry per resource, whatever the cloud.
//
//   {
//     "format": "sam-created-resources/1",
//     "resources": [{
//       "cloud": "gcp" | "aws" | "azure" | ...,
//       "kind": "kms-key" | "iam-binding" | "service-account" | ...,   // the cloud's own terms
//       "name": "<the cloud's identifier for it>",                     // unique per cloud+kind
//       "attributes": { "project": "...", "role": "...", ... },        // strings, never secrets
//       "createdBy": "gcp-bootstrap",
//       "action": "created" | "reused",       // reused: existed before; a teardown leaves it
//       "createdAt": "<ISO time>",
//       "removedAt": "<ISO time>"             // set once a teardown removed it
//     }]
//   }
//
// Used by deploy/selfhost/gcp-bootstrap.sh:
//   created-resources.mjs add <file> <cloud> <kind> <name> <created|reused> <createdBy> [k=v ...]
//   created-resources.mjs list <file> <cloud> <createdBy>   -> kind<TAB>name<TAB>action<TAB>removedAt
//   created-resources.mjs removed <file> <cloud> <kind> <name>
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const FORMAT = 'sam-created-resources/1';
const SECRETISH = /(secret|token|password|private|credential|key-material)/i;

export function readRecord(file) {
  if (!existsSync(file)) return { format: FORMAT, resources: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed?.format !== FORMAT || !Array.isArray(parsed.resources)) {
    throw new Error(`${file} is not a ${FORMAT} record`);
  }
  const names = new Set();
  for (const r of parsed.resources) {
    if (
      !r ||
      typeof r.cloud !== 'string' ||
      !r.cloud ||
      typeof r.kind !== 'string' ||
      !r.kind ||
      typeof r.name !== 'string' ||
      !r.name ||
      typeof r.createdBy !== 'string' ||
      !['created', 'reused'].includes(r.action) ||
      (r.attributes !== undefined &&
        (!r.attributes ||
          typeof r.attributes !== 'object' ||
          Array.isArray(r.attributes) ||
          Object.values(r.attributes).some((v) => typeof v !== 'string')))
    ) {
      throw new Error('invalid resource receipt; refusing ambiguous ownership');
    }
    const key = JSON.stringify([r.cloud, r.kind, r.name]);
    if (names.has(key)) throw new Error('duplicate resource receipt; refusing ambiguous ownership');
    names.add(key);
  }
  return parsed;
}

function writeRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    const data = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    let offset = 0;
    while (offset < data.length) {
      const count = writeSync(fd, data, offset, data.length - offset);
      if (!count) throw new Error('Cannot persist resource receipt');
      offset += count;
    }
    fsyncSync(fd);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  const parent = openSync(dirname(file), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

/** Absence was checked before an exact unconditional IAM mutation; retain that intent on retry. */
export function grantIntent(file, entry) {
  const attrs = entry.attributes ?? {};
  const required = [
    'project',
    'install',
    'identity',
    'pool',
    'environment',
    'installation',
    'account',
    'member',
    'role',
    'condition',
  ];
  if (
    entry.cloud !== 'gcp' ||
    entry.createdBy !== 'gcp-bootstrap' ||
    !['created', 'reused'].includes(entry.action) ||
    !['iam-binding', 'service-account-iam-binding'].includes(entry.kind) ||
    required.some((key) => typeof attrs[key] !== 'string' || !attrs[key]) ||
    attrs.condition !== 'None'
  )
    throw new Error('Incomplete unconditional IAM grant intent');
  const prior = readRecord(file).resources.find(
    (r) => r.cloud === entry.cloud && r.kind === entry.kind && r.name === entry.name
  );
  if (prior && !prior.removedAt) {
    if (
      (prior.attributes?.grantPending &&
        prior.attributes.grantPending !== 'unconditional-grant/1') ||
      prior.createdBy !== entry.createdBy ||
      required.some(
        (key) =>
          (prior.attributes?.[key] ?? (key === 'condition' ? 'None' : undefined)) !== attrs[key]
      )
    )
      throw new Error('IAM grant identity or ownership scope changed; refusing intent adoption');
    // A present preexisting grant stays reused. An observed absent grant is a new creation.
    if (prior.action === 'created') entry.action = 'created';
  }
  entry.attributes = {
    ...attrs,
    grantPending: entry.action === 'created' ? 'unconditional-grant/1' : '',
  };
  addResource(file, entry);
}

/**
 * Adds or refreshes one entry. A live resource once recorded as created never becomes "reused".
 * An entry a teardown removed that is recorded again exists again: it takes the new action and
 * loses its removedAt, so a later teardown neither skips it as already removed nor deletes a
 * resource this run only found (reused).
 */
export function addResource(file, entry, now = new Date()) {
  for (const key of Object.keys(entry.attributes ?? {})) {
    if (SECRETISH.test(key))
      throw new Error(`refusing to record attribute ${key}: no secrets here`);
  }
  const record = readRecord(file);
  const existing = record.resources.find(
    (r) => r.cloud === entry.cloud && r.kind === entry.kind && r.name === entry.name
  );
  if (existing) {
    const replaced =
      existing.attributes?.identity &&
      entry.attributes?.identity &&
      existing.attributes.identity !== entry.attributes.identity;
    if (
      !existing.removedAt &&
      !replaced &&
      ['install', 'installation', 'environment'].some(
        (key) =>
          existing.attributes?.[key] &&
          entry.attributes?.[key] &&
          existing.attributes[key] !== entry.attributes[key]
      )
    ) {
      throw new Error('resource ownership scope changed; refusing to adopt an existing receipt');
    }
    if (existing.removedAt || replaced) {
      Object.assign(existing, { action: entry.action, createdAt: now.toISOString() });
      delete existing.removedAt;
    } else if (existing.action !== 'created') {
      existing.action = entry.action;
    }
    existing.attributes = { ...existing.attributes, ...entry.attributes };
  } else {
    record.resources.push({ ...entry, createdAt: now.toISOString() });
  }
  writeRecord(file, record);
}

export function markRemoved(file, cloud, kind, name, now = new Date()) {
  const record = readRecord(file);
  const entry = record.resources.find(
    (r) => r.cloud === cloud && r.kind === kind && r.name === name
  );
  if (!entry) throw new Error(`${cloud} ${kind} ${name} is not in ${file}`);
  entry.removedAt = now.toISOString();
  writeRecord(file, record);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, file, ...rest] = process.argv.slice(2);
  try {
    if (command === 'add' || command === 'grant-intent') {
      const [cloud, kind, name, action, createdBy, ...pairs] = rest;
      if (!cloud || !kind || !name || !['created', 'reused'].includes(action) || !createdBy) {
        throw new Error(
          'usage: add <file> <cloud> <kind> <name> <created|reused> <createdBy> [k=v ...]'
        );
      }
      const attributes = Object.fromEntries(
        pairs.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
      );
      const entry = { cloud, kind, name, attributes, createdBy, action };
      if (command === 'grant-intent') grantIntent(file, entry);
      else addResource(file, entry);
    } else if (command === 'list') {
      const [cloud, createdBy] = rest;
      for (const r of readRecord(file).resources) {
        if (r.cloud === cloud && r.createdBy === createdBy) {
          process.stdout.write(`${r.kind}\t${r.name}\t${r.action}\t${r.removedAt ?? ''}\n`);
        }
      }
    } else if (command === 'removed') {
      const [cloud, kind, name] = rest;
      markRemoved(file, cloud, kind, name);
    } else {
      throw new Error('usage: created-resources.mjs add|list|removed <file> ...');
    }
  } catch (error) {
    process.stderr.write(`created-resources: ${error.message}\n`);
    process.exit(1);
  }
}
