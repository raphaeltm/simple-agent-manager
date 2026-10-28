import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalSourceBootstrap } from './installer-source-cache.mjs';
import { createRequire } from 'node:module';
const installerRequire = createRequire(
  new URL('../../apps/installer/package.json', import.meta.url)
);
const wranglerRequire = createRequire(installerRequire.resolve('wrangler/package.json'));
const { transform } = wranglerRequire('esbuild');
const transformed = await transform(
  'export const source = ' + JSON.stringify(canonicalSourceBootstrap),
  { format: 'esm', keepNames: true }
);
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compiled = await import(moduleUrl(transformed.code));
const { default: restoreCanonicalSource } = await import(
  moduleUrl('export default ' + compiled.source)
);
test('keepNames compiled bootstrap runs cleanly, restores full history offline and rejects tampering', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'sam-source-cache-'));
  try {
    const remote = join(root, 'upstream');
    fs.mkdirSync(remote);
    const git = (...args) =>
      execFileSync('/usr/bin/git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    git('init', remote);
    git('-C', remote, 'config', 'user.email', 'test@example.com');
    git('-C', remote, 'config', 'user.name', 'Test');
    fs.writeFileSync(join(remote, 'source'), 'baseline');
    git('-C', remote, 'add', '.');
    git('-C', remote, 'commit', '-m', 'first');
    const first = git('-C', remote, 'rev-parse', 'HEAD');
    fs.writeFileSync(join(remote, 'source'), 'approved');
    git('-C', remote, 'commit', '-am', 'second');
    const commit = git('-C', remote, 'rev-parse', 'HEAD');
    const objects = new Map();
    const store = {
      get(key, file) {
        if (!objects.has(key)) return false;
        fs.writeFileSync(file, objects.get(key));
        return true;
      },
      put(key, file) {
        if (!objects.has(key)) objects.set(key, fs.readFileSync(file));
      },
    };
    const environment = { SAM_SOURCE_COMMIT: commit };
    const one = await restoreCanonicalSource({
      environment,
      store,
      remote,
      directory: join(root, 'first'),
      work: join(root, 'work'),
    });
    environment.SAM_SOURCE_IDENTITY = JSON.stringify(one);
    fs.rmSync(remote, { recursive: true });
    const two = await restoreCanonicalSource({
      environment,
      store,
      remote,
      directory: join(root, 'restored'),
      work: join(root, 'work'),
    });
    assert.deepEqual(one, two);
    assert.equal(git('-C', join(root, 'restored'), 'show', `${first}:source`), 'baseline');
    assert.equal(fs.readFileSync(join(root, 'restored', 'source'), 'utf8'), 'approved');
    const savedManifest = objects.get(`${commit}.json`);
    objects.delete(`${commit}.json`);
    await assert.rejects(
      restoreCanonicalSource({
        environment,
        store,
        remote,
        directory: join(root, 'missing'),
        work: join(root, 'work'),
      }),
      /manifest missing/
    );
    for (const changed of [
      { ...one, tree: 'f'.repeat(40) },
      { ...one, bundleSHA256: 'f'.repeat(64) },
      { ...one, bundleBytes: one.bundleBytes + 1 },
    ]) {
      objects.set(`${commit}.json`, Buffer.from(JSON.stringify(changed)));
      await assert.rejects(
        restoreCanonicalSource({
          environment,
          store,
          remote,
          directory: join(root, 'changed'),
          work: join(root, 'work'),
        }),
        /identity changed/
      );
    }
    objects.set(`${commit}.json`, savedManifest);
    objects.set(`objects/${one.bundleSHA256}.bundle`, Buffer.from('tampered'));
    await assert.rejects(
      restoreCanonicalSource({
        environment,
        store,
        remote,
        directory: join(root, 'broken'),
        work: join(root, 'work'),
      }),
      /integrity/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
