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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const FORMAT = 'sam-created-resources/1';
const SECRETISH = /(secret|token|password|private|credential|key-material)/i;

export function readRecord(file) {
  if (!existsSync(file)) return { format: FORMAT, resources: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed?.format !== FORMAT || !Array.isArray(parsed.resources)) {
    throw new Error(`${file} is not a ${FORMAT} record`);
  }
  return parsed;
}

function writeRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Adds or refreshes one entry. A resource once recorded as created never becomes "reused". */
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
    if (existing.removedAt && entry.action === 'created') {
      Object.assign(existing, { action: 'created', createdAt: now.toISOString() });
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
    if (command === 'add') {
      const [cloud, kind, name, action, createdBy, ...pairs] = rest;
      if (!cloud || !kind || !name || !['created', 'reused'].includes(action) || !createdBy) {
        throw new Error(
          'usage: add <file> <cloud> <kind> <name> <created|reused> <createdBy> [k=v ...]'
        );
      }
      const attributes = Object.fromEntries(
        pairs.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
      );
      addResource(file, { cloud, kind, name, attributes, createdBy, action });
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
