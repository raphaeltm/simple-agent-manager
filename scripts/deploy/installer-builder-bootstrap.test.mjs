import test from 'node:test';
import assert from 'node:assert/strict';
import { builderEngineConfig } from './installer-builder-bootstrap-engine.mjs';
test('approved source chooses only fixed runtime commands and owner config', () => {
  const approved = 'a'.repeat(40);
  const config = builderEngineConfig(
    {
      sourceCommit: approved,
      ownerEmail: 'owner@example.com',
      workersDev: { action: 'preserve', subdomain: 'approved-account' },
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
  assert.deepEqual(config.codexBuild.args, [
    'scripts/deploy/prepare-codex-runtime-artifact.sh',
    'apps/api/container-artifacts',
  ]);
  assert.equal(config.ownerEmail, 'owner@example.com');
  assert.deepEqual(config.workersDev, { action: 'preserve', subdomain: 'approved-account' });
  assert.equal(config.cloudflareApiUrl, undefined);
  assert.equal(config.secrets, undefined);
  assert.throws(() => builderEngineConfig({ sourceCommit: 'main' }, approved), /approval mismatch/);
});

// Exercise Wrangler's installed command constructor, not a reimplementation of it.
// This intentionally fails closed when an SDK update removes/moves its switch.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('engine launcher uses the running Node and repository-local tsx without PATH resolution', async () => {
  const source = readFileSync(
    new URL('./installer-builder-bootstrap-engine.mjs', import.meta.url),
    'utf8'
  );
  assert.ok(source.includes('process.execPath'));
  assert.ok(source.includes("new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)"));
  assert.ok(!source.includes("spawn(\n    'pnpm'"));
});

test('builder failures name the failing bootstrap line on stderr', () => {
  // Tool stdout is discarded in the builder, so stderr is the only failure evidence.
  // An invalid commit fails the validation line before any network or filesystem work.
  const script = fileURLToPath(new URL('./installer-builder-bootstrap.sh', import.meta.url));
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SAM_SOURCE_COMMIT: 'not-a-commit',
      SAM_JOB_DIRECTORY: '/sam/job',
      SAM_BUILD_FIT_ONLY: '1',
    },
  });
  const line =
    readFileSync(script, 'utf8')
      .split('\n')
      .findIndex((text) => text.includes('"$SAM_SOURCE_COMMIT" =~')) + 1;
  assert.notEqual(result.status, 0);
  assert.ok(line > 0);
  assert.equal(result.stderr.trim(), `installer-builder-bootstrap.sh failed at line ${line}`);
});

test('every checksum-pinned builder download names an immutable version', () => {
  // A moving URL behind a fixed checksum fails silently on the next upstream release.
  const source = readFileSync(new URL('./installer-builder-bootstrap.sh', import.meta.url), 'utf8');
  assert.ok(!/^\s*curl /m.test(source.replace(/fetch_pinned\(\) \{[\s\S]*?\n\}\n/, '')));
  const calls = [
    ...source.matchAll(
      /^fetch_pinned (\S+) ([a-f0-9]{64})((?: \\\n)?(?: +https:\/\/\S+(?: \\\n)?)+)/gm
    ),
  ];
  assert.equal(calls.length, 2);
  const urls = calls.flatMap((call) => call[3].match(/https:\/\/\S+/g));
  assert.equal(urls.length, 4);
  for (const url of urls) assert.match(url, /[/-]v?\d+\.\d+\.\d+[/-]|go\d+\.\d+\.\d+\./, url);
});

test('pinned downloads fail over between sources and reject wrong bytes', () => {
  const source = readFileSync(new URL('./installer-builder-bootstrap.sh', import.meta.url), 'utf8');
  const helper = source.match(/fetch_pinned\(\) \{[\s\S]*?\n\}\n/)[0];
  const dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
  try {
    // Stub curl: "missing" answers 404, "wrong" serves other bytes, "good" serves the payload.
    writeFileSync(
      join(dir, 'curl'),
      `#!/usr/bin/env bash
while (($#)); do case "$1" in -o) out=$2; shift;; https://*) url=$1;; esac; shift; done
case "$url" in
  *missing*) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22;;
  *wrong*) printf 'tampered' > "$out";;
  *good*) printf 'payload' > "$out";;
esac
`,
      { mode: 0o755 }
    );
    const sha = createHash('sha256').update('payload').digest('hex');
    const run = (...urls) =>
      spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\n${helper}fetch_pinned "$@"`,
          'fetch',
          join(dir, 'out'),
          sha,
          ...urls,
        ],
        {
          encoding: 'utf8',
          env: { PATH: `${dir}:${process.env.PATH}`, SAM_FETCH_RETRY_DELAY_SECONDS: '0' },
        }
      );

    const recovered = run(
      'https://example.test/missing/v1.0.0/x',
      'https://example.test/good/v1.0.0/x'
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readFileSync(join(dir, 'out'), 'utf8'), 'payload');
    assert.match(recovered.stderr, /attempt 1 failed: https:\/\/example\.test\/missing/);

    const rejected = run('https://example.test/wrong/v1.0.0/x');
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stderr.match(/failed: /g)?.length, 6);
    assert.equal(existsSync(join(dir, 'out')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
