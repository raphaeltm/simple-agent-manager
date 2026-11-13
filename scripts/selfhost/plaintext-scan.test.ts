/**
 * The plaintext listing and purge over the gs:// path (`gcloud storage ls --long`, `cat`, `rm`),
 * with an in-memory bucket. The live suite runs the same code on a real celld bucket over s3://
 * (live/plaintext-purge.live.test.ts); this covers the references that suite cannot easily
 * produce: a queue attachment and a named pointer naming an old plaintext version.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { BoxContext, RunResult } from './backup-lib';
import {
  formatPlaintextReport,
  type KnownSecrets,
  manifestVars,
  purgeVersions,
  scanBackups,
  scanDeployVersions,
  scanRemoteBackups,
} from './plaintext-scan';

const ROOT = 'gs://fleet/celld';
const SECRET_VALUE = randomBytes(16).toString('hex');
let objects: Map<string, string>;
let deleted: string[];

function manifest(vars: Record<string, string>): string {
  return JSON.stringify({
    version: 'v',
    raw_metadata: {
      bindings: Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    },
  });
}

/** Objects by full URL; `put` takes a key under the fleet bucket or a full gs:// URL. */
function put(key: string, body: string): void {
  objects.set(key.startsWith('gs://') ? key : `${ROOT}/${key}`, body);
}

function run(command: string, args: string[]): RunResult {
  const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
  if (command !== 'gcloud' || args[0] !== 'storage')
    return { status: 2, stdout: '', stderr: 'unexpected' };
  if (args[1] === 'ls') {
    const prefix = (args.at(-1) ?? '').replace(/\*\*$/, '');
    const lines = [...objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .map(
        (k) => `       ${objects.get(k)?.length ?? 0}  2026-11-1${k.length % 9}T10:00:00Z  ${k}`
      );
    if (lines.length === 0)
      return { status: 1, stdout: '', stderr: 'ERROR: One or more URLs matched no objects.' };
    return ok(`${lines.join('\n')}\nTOTAL: ${lines.length} objects\n`);
  }
  if (args[1] === 'cat') return ok(objects.get(args[2] ?? '') ?? '');
  if (args[1] === 'rm') {
    for (const url of args.slice(2)) {
      deleted.push(url.slice(ROOT.length + 1));
      objects.delete(url);
    }
    return ok();
  }
  return { status: 2, stdout: '', stderr: 'unexpected' };
}

const ctx = (): BoxContext => ({
  box: { CELLD_BUCKET: ROOT },
  envFile: '',
  stateDir: '',
  composeFiles: [],
  run,
  now: () => 0,
  log: () => undefined,
});
/** The fake listing dates objects 2026-11-1x; a clock well after that makes them old enough. */
const OLD_ENOUGH = { now: Date.parse('2026-12-31T00:00:00Z') };
const secrets: KnownSecrets = {
  names: new Set(['ENCRYPTION_KEY', 'GITHUB_CLIENT_SECRET']),
  values: [SECRET_VALUE],
};

beforeEach(() => {
  objects = new Map();
  deleted = [];
  put(
    'deploy/workspaces-api/v1/manifest.json',
    manifest({ ENCRYPTION_KEY: SECRET_VALUE, PLAIN: 'x' })
  );
  put('deploy/workspaces-api/v1/worker.js', 'code');
  put(
    'deploy/workspaces-api/v2/manifest.json',
    manifest({ GITHUB_CLIENT_SECRET: randomBytes(16).toString('hex') })
  );
  put('deploy/workspaces-api/v2/worker.js', 'code');
  put(
    'deploy/workspaces-api/v3/manifest.json',
    manifest({ SAM_KEY_AGENT_URL: 'http://127.0.0.1:7190' })
  );
  put('deploy/workspaces-api/v3/worker.js', 'code');
  const pointer = JSON.stringify({ version: 'v3', prefix: 'deploy/workspaces-api/v3' });
  put('deploy/current.json', pointer);
  put('deploy/workspaces-api/current.json', pointer);
  put('deploy/images/abc.tar', 'image');
});

describe('plaintext listing', () => {
  it('reads plain-text vars from the manifest bindings', () => {
    expect(manifestVars(manifest({ A: '1' }))).toEqual({ A: '1' });
  });

  it('finds every version, which hold secrets (names only), and which celld still reads', () => {
    const versions = scanDeployVersions(ctx(), secrets);
    const byPrefix = Object.fromEntries(versions.map((v) => [v.prefix, v]));
    expect(Object.keys(byPrefix).sort()).toEqual([
      'deploy/workspaces-api/v1',
      'deploy/workspaces-api/v2',
      'deploy/workspaces-api/v3',
    ]);
    expect(byPrefix['deploy/workspaces-api/v1']?.secretNames).toEqual([
      '(a known secret value)',
      'ENCRYPTION_KEY',
    ]);
    expect(byPrefix['deploy/workspaces-api/v2']?.secretNames).toEqual(['GITHUB_CLIENT_SECRET']);
    expect(byPrefix['deploy/workspaces-api/v3']?.referencedBy.sort()).toEqual([
      'deploy/current.json',
      'deploy/workspaces-api/current.json',
    ]);
    const report = formatPlaintextReport(ROOT, versions, [], '/backups').join('\n');
    expect(report).toContain('2 with plaintext secrets');
    expect(report).toContain('ENCRYPTION_KEY: rotate it with pnpm selfhost:secrets rotate encryption-key');
    expect(report).toContain('GITHUB_CLIENT_SECRET: regenerate it in the GitHub App settings');
    expect(report).not.toContain(SECRET_VALUE);
  });

  it('lists local backups holding plaintext keys, secrets files or plaintext deploy versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'sam-scan-backups-'));
    const old = join(root, '2026-11-01');
    mkdirSync(join(old, 'state'), { recursive: true });
    mkdirSync(join(old, 'bucket/deploy/workspaces-api/v1'), { recursive: true });
    writeFileSync(
      join(old, 'backup-manifest.json'),
      JSON.stringify({ version: 1, createdAt: '2026-11-01T00:00:00Z', objectCount: 1 })
    );
    writeFileSync(join(old, 'state/platform-keys.json'), '{}');
    writeFileSync(
      join(old, 'bucket/deploy/workspaces-api/v1/manifest.json'),
      manifest({ ENCRYPTION_KEY: SECRET_VALUE })
    );
    const [finding] = scanBackups(root, secrets);
    expect(finding?.holds).toEqual([
      'state/platform-keys.json',
      'bucket deploy versions with (a known secret value), ENCRYPTION_KEY',
    ]);
  });
});

describe('backups in another bucket', () => {
  it('groups by folder, checks deploy manifests, names state files and unopened archives', () => {
    const backup = 'gs://box-backups';
    put(
      `${backup}/r1/fleet/deploy/workspaces-api/v1/manifest.json`,
      manifest({ ENCRYPTION_KEY: SECRET_VALUE })
    );
    put(`${backup}/r1/state/platform-keys.json`, '{}');
    put(`${backup}/r2/box-state/state-and-env.tgz`, 'tar');
    put(`${backup}/clean/fleet/deploy/workspaces-api/v3/manifest.json`, manifest({ PLAIN: 'x' }));
    const findings = scanRemoteBackups(ctx(), backup, secrets);
    expect(findings.map((f) => [f.dir, f.holds])).toEqual([
      [`${backup}/clean`, []],
      [
        `${backup}/r1`,
        ['platform-keys.json', 'deploy versions with (a known secret value), ENCRYPTION_KEY'],
      ],
      [`${backup}/r2`, [expect.stringContaining('archive state-and-env.tgz (not opened')]],
    ]);
  });
});

describe('purge', () => {
  it('deletes the unreferenced plaintext versions only, object by object', () => {
    const result = purgeVersions(ctx(), secrets, ROOT, OLD_ENOUGH);
    expect(result.deleted.sort()).toEqual(['deploy/workspaces-api/v1', 'deploy/workspaces-api/v2']);
    expect(deleted.sort()).toEqual([
      'deploy/workspaces-api/v1/manifest.json',
      'deploy/workspaces-api/v1/worker.js',
      'deploy/workspaces-api/v2/manifest.json',
      'deploy/workspaces-api/v2/worker.js',
    ]);
    expect(objects.has(`${ROOT}/deploy/images/abc.tar`)).toBe(true);
  });

  it('never deletes a plaintext version a queue attachment still names', () => {
    put(
      'deploy/queues/jobs/consumer.json',
      JSON.stringify({
        consumer: {
          script_name: 'workspaces-api',
          version: 'v1',
          prefix: 'deploy/workspaces-api/v1',
        },
      })
    );
    const result = purgeVersions(ctx(), secrets, ROOT, OLD_ENOUGH);
    expect(result.deleted).toEqual(['deploy/workspaces-api/v2']);
    expect(result.skipped).toEqual(['deploy/workspaces-api/v1 (still referenced)']);
    expect(objects.has(`${ROOT}/deploy/workspaces-api/v1/manifest.json`)).toBe(true);
  });

  it('refuses without the exact bucket confirmation, and while the current version holds plaintext', () => {
    expect(() => purgeVersions(ctx(), secrets, 'gs://other')).toThrow(
      /--confirm gs:\/\/fleet\/celld/
    );
    put('deploy/current.json', JSON.stringify({ prefix: 'deploy/workspaces-api/v1' }));
    expect(() => purgeVersions(ctx(), secrets, ROOT, OLD_ENOUGH)).toThrow(
      /current deploy version still holds plaintext/
    );
    expect(deleted).toEqual([]);
  });

  it('counts a holder that names only the version id as a reference (fails toward keeping)', () => {
    put('deploy/workspaces-api/current.json', JSON.stringify({ version: 'v2' }));
    put('deploy/current.json', JSON.stringify({ version: 'v3' }));
    const result = purgeVersions(ctx(), secrets, ROOT, OLD_ENOUGH);
    expect(result.deleted).toEqual(['deploy/workspaces-api/v1']);
    expect(objects.has(`${ROOT}/deploy/workspaces-api/v2/manifest.json`)).toBe(true);
  });

  it('refuses when a pointer or attachment names no version it can recognise', () => {
    put('deploy/queues/jobs/consumer.json', JSON.stringify({ consumer: { script_name: 'x' } }));
    expect(() => purgeVersions(ctx(), secrets, ROOT, OLD_ENOUGH)).toThrow(
      /no known deploy version is named in deploy\/queues\/jobs\/consumer\.json/
    );
    expect(deleted).toEqual([]);
  });

  it('never deletes a version written within the minimum age (a deploy may still be writing it)', () => {
    const result = purgeVersions(ctx(), secrets, ROOT, { now: Date.parse('2026-11-10T12:00:00Z') });
    expect(result.deleted).toEqual([]);
    expect(result.skipped.every((line) => line.includes('written less than 24 h ago'))).toBe(true);
  });
});
