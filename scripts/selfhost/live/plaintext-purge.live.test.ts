/**
 * The plaintext listing and purge (plaintext-scan.ts) against a bucket layout made by real
 * `celld deploy` runs: celld 0.6.3 (pinned, checksum-verified) over the box's object store (the
 * pinned MinIO image), read and written through the same `mc` path the box uses.
 *
 * Three versions are deployed the way a box migrating to sealed secrets leaves them: two old ones
 * with a secret as a plain var (what every pre-sealing deploy did), then a clean current one.
 * The listing must find exactly the two; the purge must refuse without the confirmation, delete
 * exactly the two, leave every pointer and the current version, and celld must still serve the
 * current version after a restart. A current version that still holds plaintext stops the purge.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCommand } from '../backup-cli';
import { type BoxContext, OBJECTSTORE_IMAGE } from '../backup-lib';
import { listObjects, readObject } from '../bucket-objects';
import { ensureCelldBinary, resolveEsbuild } from '../celld-binary.js';
import { type KnownSecrets, purgeVersions, scanDeployVersions } from '../plaintext-scan';
import { freePort, LIVE_TMP, REPO_ROOT, type Running, start, waitFor } from './harness';

const KEY = 'sam-live-purge';
const SECRET = 'live-purge-store-0123456789';
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;

let root = '';
let container = '';
let binary = '';
let celld: Running | undefined;
let ports: { store: number; celld: number; internal: number };
const canary = `live-purge-canary-${randomBytes(12).toString('hex')}`;
const storeEnv = () => ({
  AWS_ACCESS_KEY_ID: KEY,
  AWS_SECRET_ACCESS_KEY: SECRET,
  AWS_REGION: 'us-east-1',
});
const bucketArgs = () => [
  '--bucket',
  's3://fleet/celld',
  '--endpoint',
  `http://127.0.0.1:${ports.store}`,
];
const secrets = (): KnownSecrets => ({ names: new Set(['ENCRYPTION_KEY']), values: [canary] });

function ctx(): BoxContext {
  return {
    box: {
      CELLD_BUCKET: 's3://fleet/celld',
      S3_ENDPOINT: `http://127.0.0.1:${ports.store}`,
      AWS_ACCESS_KEY_ID: KEY,
      AWS_SECRET_ACCESS_KEY: SECRET,
    },
    envFile: '',
    stateDir: join(root, 'state'),
    composeFile: '',
    run: runCommand,
    now: () => Date.now(),
    log: () => undefined,
    user: `${process.getuid?.()}:${process.getgid?.()}`,
  };
}

/** Deploys a Worker that answers its marker; `secret` set means the pre-sealing plain-var path. */
function deploy(marker: string, secret: boolean): void {
  const project = join(root, `project-${marker}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'worker.js'),
    `export default { fetch(_r, env) { return Response.json({ marker: ${JSON.stringify(marker)}, has: typeof env.ENCRYPTION_KEY }); } };`
  );
  writeFileSync(
    join(project, 'wrangler.json'),
    JSON.stringify({
      name: 'workspaces-api',
      main: 'worker.js',
      compatibility_date: '2026-01-01',
      vars: {
        PLAIN_VAR: `plain-${marker}`,
        ...(secret
          ? { ENCRYPTION_KEY: canary }
          : { SAM_KEY_AGENT_URL: 'http://127.0.0.1:7190/v1/secrets' }),
      },
    })
  );
  const result = spawnSync(binary, ['deploy', project, ...bucketArgs()], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...storeEnv(),
      CELLD_ESBUILD: resolveEsbuild(join(REPO_ROOT, 'apps/api')),
    },
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
}

function startCelld(): Running {
  return start(
    binary,
    [
      ...bucketArgs(),
      '--listen',
      `127.0.0.1:${ports.celld}`,
      '--internal-listen',
      `127.0.0.1:${ports.internal}`,
    ],
    storeEnv()
  );
}

async function served(): Promise<string> {
  const reload = await fetch(`http://127.0.0.1:${ports.internal}/reload`, { method: 'POST' }).catch(
    () => null
  );
  if (!reload?.ok) return '';
  const response = await fetch(`http://127.0.0.1:${ports.celld}/`).catch(() => null);
  return response?.ok ? String(((await response.json()) as { marker?: unknown }).marker) : '';
}

describe.skipIf(!hasDocker && !process.env.CI)(
  'plaintext listing and purge on a real celld bucket',
  () => {
    beforeAll(async () => {
      ports = { store: await freePort(), celld: await freePort(), internal: await freePort() };
      mkdirSync(LIVE_TMP, { recursive: true });
      root = mkdtempSync(join(LIVE_TMP, 'purge-'));
      const run = spawnSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
          '--network',
          'host',
          '-e',
          `MINIO_ROOT_USER=${KEY}`,
          '-e',
          `MINIO_ROOT_PASSWORD=${SECRET}`,
          '--entrypoint',
          'minio',
          OBJECTSTORE_IMAGE,
          'server',
          '/data',
          '--address',
          `127.0.0.1:${ports.store}`,
          '--console-address',
          `127.0.0.1:${await freePort()}`,
        ],
        { encoding: 'utf8' }
      );
      expect(run.status, run.stderr).toBe(0);
      container = run.stdout.trim();
      await waitFor(
        'object store',
        async () =>
          (await fetch(`http://127.0.0.1:${ports.store}/minio/health/live`).catch(() => null))?.ok
      );
      const mb = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'host',
          '-e',
          `MC_HOST_src=http://${KEY}:${SECRET}@127.0.0.1:${ports.store}`,
          '-e',
          'MC_CONFIG_DIR=/tmp/mc',
          '--entrypoint',
          'mc',
          OBJECTSTORE_IMAGE,
          'mb',
          'src/fleet',
        ],
        { encoding: 'utf8' }
      );
      expect(mb.status, mb.stderr).toBe(0);
      binary = await ensureCelldBinary(join(LIVE_TMP, 'celld-bin'));
      celld = startCelld();
      deploy('old-1', true);
      deploy('old-2', true);
      deploy('sealed', false);
      await waitFor(
        'celld to serve the current version',
        async () => (await served()) === 'sealed',
        120_000,
        () => celld?.output() ?? ''
      );
    }, 300_000);

    afterAll(async () => {
      await celld?.stop();
      if (container) spawnSync('docker', ['rm', '-f', container]);
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('lists the two plaintext versions and the clean, referenced current one', () => {
      const versions = scanDeployVersions(ctx(), secrets());
      expect(versions).toHaveLength(3);
      const current = versions.filter((v) => v.referencedBy.includes('deploy/current.json'));
      expect(current).toHaveLength(1);
      expect(current[0]?.secretNames).toEqual([]);
      const dirty = versions.filter((v) => v.secretNames.length > 0);
      expect(dirty).toHaveLength(2);
      for (const v of dirty) {
        expect(v.referencedBy).toEqual([]);
        expect(v.secretNames).toEqual(['(a known secret value)', 'ENCRYPTION_KEY']);
      }
    });

    it('refuses without the confirmation, then deletes exactly the unreferenced plaintext versions', async () => {
      expect(() => purgeVersions(ctx(), secrets(), undefined)).toThrow(
        /--confirm s3:\/\/fleet\/celld/
      );
      const before = listObjects(ctx(), 'deploy/').map((o) => o.key);
      const pointers = ['deploy/current.json', 'deploy/workspaces-api/current.json'].map((k) =>
        readObject(ctx(), k)
      );
      const result = purgeVersions(ctx(), secrets(), 's3://fleet/celld');
      expect(result.deleted).toHaveLength(2);
      const after = listObjects(ctx(), 'deploy/').map((o) => o.key);
      for (const prefix of result.deleted) {
        expect(after.some((k) => k.startsWith(`${prefix}/`))).toBe(false);
      }
      // Everything else is untouched: pointers byte for byte, the current version's objects.
      expect(
        ['deploy/current.json', 'deploy/workspaces-api/current.json'].map((k) =>
          readObject(ctx(), k)
        )
      ).toEqual(pointers);
      expect(after).toEqual(
        before.filter((k) => !result.deleted.some((p) => k.startsWith(`${p}/`)))
      );
      // No plaintext left anywhere under deploy/.
      for (const key of after) expect(readObject(ctx(), key)).not.toContain(canary);
    });

    it('celld still boots and serves the current version from the purged bucket', async () => {
      await celld?.stop();
      celld = startCelld();
      await waitFor(
        'celld after restart',
        async () => (await served()) === 'sealed',
        120_000,
        () => celld?.output() ?? ''
      );
    }, 180_000);

    it('refuses to purge while the current version itself holds plaintext', async () => {
      deploy('legacy-again', true);
      await waitFor(
        'the plaintext version to be current',
        async () => (await served()) === 'legacy-again',
        120_000
      );
      expect(() => purgeVersions(ctx(), secrets(), 's3://fleet/celld')).toThrow(
        /current deploy version still holds plaintext/
      );
    }, 180_000);
  }
);
