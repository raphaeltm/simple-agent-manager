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
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCommand } from '../backup-cli';
import type { BoxContext } from '../backup-lib';
import { listObjects, readObject } from '../bucket-objects';
import { ensureCelldBinary } from '../celld-binary.js';
import { type KnownSecrets, purgeVersions, scanDeployVersions } from '../plaintext-scan';
import {
  type CelldNode,
  celldNode,
  hasDocker,
  type ObjectStore,
  startObjectStore,
  writeProject,
} from './celld-lab';
import { LIVE_TMP, type Running, waitFor } from './harness';

const KEY = 'sam-live-purge';
const SECRET = 'live-purge-store-0123456789';

let root = '';
let store: ObjectStore | undefined;
let node: CelldNode;
let celld: Running | undefined;
const canary = `live-purge-canary-${randomBytes(12).toString('hex')}`;
const secrets = (): KnownSecrets => ({ names: new Set(['ENCRYPTION_KEY']), values: [canary] });

function ctx(): BoxContext {
  return {
    box: {
      CELLD_BUCKET: 's3://fleet/celld',
      S3_ENDPOINT: store?.url ?? '',
      AWS_ACCESS_KEY_ID: KEY,
      AWS_SECRET_ACCESS_KEY: SECRET,
    },
    envFile: '',
    stateDir: join(root, 'state'),
    composeFiles: [],
    run: runCommand,
    now: () => Date.now(),
    log: () => undefined,
    user: `${process.getuid?.()}:${process.getgid?.()}`,
  };
}

/** Deploys a Worker that answers its marker; `secret` set means the pre-sealing plain-var path. */
function deploy(marker: string, secret: boolean): void {
  const project = writeProject(join(root, `project-${marker}`), {
    name: 'workspaces-api',
    worker: `export default { fetch(_r, env) { return Response.json({ marker: ${JSON.stringify(marker)}, has: typeof env.ENCRYPTION_KEY }); } };`,
    vars: {
      PLAIN_VAR: `plain-${marker}`,
      ...(secret
        ? { ENCRYPTION_KEY: canary }
        : { SAM_KEY_AGENT_URL: 'http://127.0.0.1:7190/v1/secrets' }),
    },
  });
  const result = node.deploy(project);
  expect(result.status, result.stderr + result.stdout).toBe(0);
}

async function served(): Promise<string> {
  const reload = await fetch(`http://127.0.0.1:${node.internalPort}/reload`, {
    method: 'POST',
  }).catch(() => null);
  if (!reload?.ok) return '';
  const response = await fetch(`http://127.0.0.1:${node.port}/`).catch(() => null);
  return response?.ok ? String(((await response.json()) as { marker?: unknown }).marker) : '';
}

describe.skipIf(!hasDocker && !process.env.CI)(
  'plaintext listing and purge on a real celld bucket',
  () => {
    beforeAll(async () => {
      mkdirSync(LIVE_TMP, { recursive: true });
      root = mkdtempSync(join(LIVE_TMP, 'purge-'));
      store = await startObjectStore(KEY, SECRET);
      node = await celldNode(
        await ensureCelldBinary(join(LIVE_TMP, 'celld-bin')),
        store,
        's3://fleet/celld'
      );
      celld = node.start();
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
      store?.stop();
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
      expect(() => purgeVersions(ctx(), secrets(), undefined, { minAgeMs: 0 })).toThrow(
        /--confirm s3:\/\/fleet\/celld/
      );
      const before = listObjects(ctx(), 'deploy/').map((o) => o.key);
      const pointers = ['deploy/current.json', 'deploy/workspaces-api/current.json'].map((k) =>
        readObject(ctx(), k)
      );
      const result = purgeVersions(ctx(), secrets(), 's3://fleet/celld', { minAgeMs: 0 });
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
      celld = node.start();
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
      expect(() => purgeVersions(ctx(), secrets(), 's3://fleet/celld', { minAgeMs: 0 })).toThrow(
        /current deploy version still holds plaintext/
      );
    }, 180_000);
  }
);
