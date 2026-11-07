import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheAuthKey, cacheKey, cachedOutputs, r2CacheStore } from './installer-build-cache.mjs';
import { filesUnder, withFakeR2 } from './installer-fake-r2.mjs';

const SECRET = 'c'.repeat(64);

test('real R2 transport stores and restores outputs and leaves no credential on disk', async () => {
  await withFakeR2(async ({ root, log, curl }) => {
    const work = join(root, 'work');
    const store = r2CacheStore({
      curlPath: curl,
      accountId: 'a'.repeat(32),
      bucket: 's123abc-pulumi-state-production',
      accessKeyId: 'b'.repeat(32),
      secretAccessKey: SECRET,
      work,
    });
    const authKey = cacheAuthKey('installation-passphrase-0123456789');
    const key = cacheKey('cli', { commit: 'd'.repeat(40) });
    const files = ['bin/sam-linux-amd64', 'bin/version.json'];
    let builds = 0;
    const run = (checkout) =>
      cachedOutputs({
        store,
        authKey,
        key,
        root: checkout,
        files,
        work,
        build: async () => {
          builds += 1;
          mkdirSync(join(checkout, 'bin'), { recursive: true });
          writeFileSync(join(checkout, files[0]), 'binary', { mode: 0o755 });
          writeFileSync(join(checkout, files[1]), '{"version":"x"}');
        },
      });
    assert.equal(await run(join(root, 'first')), 'stored');
    assert.equal(await run(join(root, 'second')), 'hit');
    assert.equal(builds, 1);
    assert.equal(readFileSync(join(root, 'second', files[0]), 'utf8'), 'binary');
    assert.equal(statSync(join(root, 'second', files[0])).mode & 0o777, 0o755);
    // Every request carried the credential...
    assert.ok(readFileSync(log, 'utf8').includes(SECRET));
    // ...and none of it outlived its request.
    for (const file of filesUnder(work))
      assert.ok(!readFileSync(file, 'utf8').includes(SECRET), file);
    assert.deepEqual(
      filesUnder(work).filter((file) => file.endsWith('.conf')),
      []
    );
  });
});

test('the cache only builds without this installation key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sam-build-cache-key-'));
  try {
    const objects = new Map();
    const store = {
      get: async () => assert.fail('no unauthenticated read'),
      put: async (key, file) => objects.set(key, readFileSync(file)),
    };
    let builds = 0;
    const result = await cachedOutputs({
      store,
      authKey: undefined,
      key: cacheKey('cli', { commit: 'e'.repeat(40) }),
      root,
      files: ['out'],
      work: join(root, 'work'),
      build: async () => {
        builds += 1;
        writeFileSync(join(root, 'out'), 'built');
      },
    });
    assert.equal(result, 'built');
    assert.equal(builds, 1);
    assert.equal(objects.size, 0);
    assert.throws(() => cacheAuthKey(''), /unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R2 transport refuses a curl resolved through PATH', () => {
  assert.throws(
    () =>
      r2CacheStore({
        accountId: 'a'.repeat(32),
        bucket: 's123abc-pulumi-state-production',
        accessKeyId: 'b'.repeat(32),
        secretAccessKey: SECRET,
        work: tmpdir(),
        curlPath: 'curl',
      }),
    /absolute path/
  );
});
