/**
 * deploy/selfhost/created-resources.mjs: what the record says after a resource a teardown removed
 * is recorded again (security review of F3, M4: a re-added grant must not read as removed).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addResource, markRemoved, readRecord } from '../../deploy/selfhost/created-resources.mjs';

let dir: string;
let file: string;
const GRANT = 'projects/p/locations/global/keyRings/r/cryptoKeys/k#roles/x#serviceAccount:box@p';
const entry = (action: 'created' | 'reused') => ({
  cloud: 'gcp',
  kind: 'iam-binding',
  name: GRANT,
  attributes: { project: 'p' },
  createdBy: 'gcp-bootstrap',
  action,
});
const only = () => readRecord(file).resources[0];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'created-resources-'));
  file = join(dir, 'created-resources.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('addResource after a teardown removed the entry', () => {
  it('recorded again as reused: exists again, as reused (a teardown lists it, never deletes it)', () => {
    addResource(file, entry('created'));
    markRemoved(file, 'gcp', 'iam-binding', GRANT);
    addResource(file, entry('reused'));
    expect(only()).toMatchObject({ action: 'reused' });
    expect(only()).not.toHaveProperty('removedAt');
  });

  it('recorded again as created: exists again, as created', () => {
    addResource(file, entry('created'));
    markRemoved(file, 'gcp', 'iam-binding', GRANT);
    addResource(file, entry('created'));
    expect(only()).toMatchObject({ action: 'created' });
    expect(only()).not.toHaveProperty('removedAt');
  });

  it('control: a live created entry never becomes reused', () => {
    addResource(file, entry('created'));
    addResource(file, entry('reused'));
    expect(only()).toMatchObject({ action: 'created' });
  });
});

it('a replacement found at a created name is reused, not adopted', () => {
  addResource(file, { ...entry('created'), attributes: { identity: 'one' } });
  addResource(file, { ...entry('reused'), attributes: { identity: 'two' } });
  expect(only()).toMatchObject({ action: 'reused', attributes: { identity: 'two' } });
});
it('refuses duplicate receipts before any destructive decisions', () => {
  writeFileSync(
    file,
    JSON.stringify({
      format: 'sam-created-resources/1',
      resources: [entry('created'), entry('created')],
    })
  );
  expect(() => readRecord(file)).toThrow('duplicate');
});
it('refuses malformed receipts', () => {
  writeFileSync(file, JSON.stringify({ format: 'sam-created-resources/1', resources: [null] }));
  expect(() => readRecord(file)).toThrow('invalid');
});

it('never rewrites live creation proof for a second installation', () => {
  addResource(file, {
    ...entry('created'),
    attributes: { identity: 'one', installation: 'first', environment: 'selfhost' },
  });
  expect(() =>
    addResource(file, {
      ...entry('reused'),
      attributes: { identity: 'one', installation: 'other', environment: 'selfhost' },
    })
  ).toThrow('ownership scope changed');
  expect(only().attributes?.installation).toBe('first');
});
