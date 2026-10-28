import test from 'node:test';
import assert from 'node:assert/strict';
import { builderEngineConfig } from './installer-builder-bootstrap-engine.mjs';
test('approved source chooses only fixed source-build commands and owner config', () => {
  const approved = 'a'.repeat(40);
  const config = builderEngineConfig(
    {
      sourceCommit: approved,
      ownerEmail: 'owner@example.com',
      accountId: 'b'.repeat(32),
      zoneId: 'c'.repeat(32),
      zoneName: 'example.com',
      baseDomain: 'sam.example.com',
      environment: 'staging',
      prefix: 's123abc',
      codexBuild: { executable: 'evil' },
      cloudflareApiUrl: 'https://evil.example',
      secrets: 'should-not-copy',
    },
    approved
  );
  assert.equal(config.codexBuild.executable, 'bash');
  assert.deepEqual(config.codexBuild.args, ['scripts/deploy/installer-builder-bootstrap-codex.sh']);
  assert.equal(config.ownerEmail, 'owner@example.com');
  assert.equal(config.cloudflareApiUrl, undefined);
  assert.equal(config.secrets, undefined);
  assert.throws(() => builderEngineConfig({ sourceCommit: 'main' }, approved), /approval mismatch/);
});

// Exercise Wrangler's installed command constructor, not a reimplementation of it.
// This intentionally fails closed when an SDK update removes/moves its switch.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
test('pinned Wrangler passes host networking to its actual Docker build command', async () => {
  const require = createRequire(new URL('../../apps/installer/package.json', import.meta.url));
  const root = dirname(require.resolve('wrangler/package.json'));
  const bundle = readFileSync(join(root, 'wrangler-dist/cli.js'), 'utf8');
  const start = bundle.indexOf('async function constructBuildCommand(options) {');
  const end = bundle.indexOf('\nasync function startContainerBuild', start);
  assert.ok(start > 0 && end > start, 'Wrangler build adapter changed; inspect before upgrading');
  const constructor = new Function(
    'fs14',
    'logger3',
    bundle.slice(start, end) + ';return constructBuildCommand;'
  )({ readFileSync: () => 'FROM scratch\n' }, { debug: () => {} });
  const old = process.env.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST;
  try {
    delete process.env.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST;
    const before = await constructor({
      tag: 'proof',
      pathToDockerfile: '/unused',
      buildContext: '.',
    });
    assert.equal(before.buildCmd.includes('--network'), false);
    process.env.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST = '1';
    const after = await constructor({
      tag: 'proof',
      pathToDockerfile: '/unused',
      buildContext: '.',
    });
    const position = after.buildCmd.indexOf('--network');
    assert.ok(position > 0);
    assert.equal(after.buildCmd[position + 1], 'host');
    assert.equal(after.buildCmd[0], 'build');
    const spawnStart = bundle.indexOf('async function dockerBuild(dockerPath, options) {');
    const spawnEnd = bundle.indexOf('\nasync function buildAndWriteContainerOutput', spawnStart);
    assert.ok(spawnStart > 0 && spawnEnd > spawnStart);
    let invocation;
    const dockerBuild = new Function(
      'childProcess',
      '__name5',
      bundle.slice(spawnStart, spawnEnd) + ';return dockerBuild;'
    )(
      {
        spawn: (executable, args) => {
          invocation = { executable, args };
          const child = new EventEmitter();
          child.stdin = {
            write: () => {},
            end: () => {
              queueMicrotask(() => child.emit('exit', 0));
            },
          };
          return child;
        },
      },
      (value) => value
    );
    const build = await dockerBuild('/usr/bin/docker', { ...after, verifyDockerIsRunning: false });
    await build.ready;
    assert.equal(invocation.executable, '/usr/bin/docker');
    const network = invocation.args.indexOf('--network');
    assert.equal(invocation.args[network + 1], 'host');
  } finally {
    if (old === undefined) delete process.env.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST;
    else process.env.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST = old;
  }
});
