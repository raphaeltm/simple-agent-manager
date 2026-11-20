/**
 * The read-only plaintext listing over the gs:// path (`gcloud storage ls --long`, `cat`), with an
 * in-memory bucket: which deploy versions and backups hold plaintext secrets (names, never
 * values), and that the listing deletes nothing (finding F10: celld forbids deleting under
 * `deploy/`, so the integration branch's purge did not land). The live suite runs the listing on
 * a real celld bucket (live/sealed-default.live.test.ts).
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
    manifest({ SAM_KEY_AGENT_ADDRESS: '127.0.0.1:7190' })
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
    expect(report).toContain('ENCRYPTION_KEY: the key every stored credential is encrypted under');
    expect(report).toContain('platform-key rotation is not available yet');
    expect(report).not.toContain('selfhost:secrets rotate');
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

// F10: the listing never deletes. Before, an opt-in `--purge` deleted old versions under
// `deploy/`, which celld's documentation forbids operators to touch; its report advertised it.
describe('deletes nothing', () => {
  it('lists every plaintext version (liveness) without one delete, and offers no purge', () => {
    const versions = scanDeployVersions(ctx(), secrets);
    expect(versions.filter((v) => v.secretNames.length > 0)).toHaveLength(2);
    const report = formatPlaintextReport(ROOT, versions, [], '/backups').join('\n');
    expect(report).toContain('not read by celld; still holds plaintext');
    expect(report).toContain('SAM does not delete old deploy versions');
    expect(report).not.toMatch(/--purge|purgeable/);
    expect(deleted).toEqual([]);
    expect(
      [...objects.keys()].filter((k) => k.includes('/v1/') || k.includes('/v2/'))
    ).toHaveLength(4);
  });

  it('exports no deletion at all', async () => {
    const module = await import('./plaintext-scan');
    expect(Object.keys(module).filter((name) => /purge|delete/i.test(name))).toEqual([]);
  });
});
