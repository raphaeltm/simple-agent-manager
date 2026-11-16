// Run in CI through scripts/quality/deploy-staging-permissions.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkInstallation, migrationTags, newMigrationTags } from './staging-migration-guard.mjs';

const main = readFileSync(new URL('../../apps/api/wrangler.toml', import.meta.url), 'utf8');
const tags = migrationTags(main, 'main');
const next = `v${Number(tags.at(-1).slice(1)) + 1}`;
const withNext = `${main}\n[[migrations]]\ntag = "${next}"\nnew_sqlite_classes = ["NewThing"]\n`;
const check = (installation, action, branchToml, mainToml = main) =>
  checkInstallation({ installation, action, branchToml, mainToml });

test('reads every migration tag of the real wrangler.toml, in order', () => {
  assert.ok(tags.length > 10);
  assert.equal(new Set(tags).size, tags.length);
  assert.equal(tags[0], 'v1');
});

test('a branch adding a migration tag is refused on primary staging deploys only', () => {
  assert.deepEqual(newMigrationTags(withNext, main), [next]);
  assert.match(check('staging', 'deploy', withNext), new RegExp(`${next}[\\s\\S]*staging2`));
  for (const [installation, action] of [
    ['staging2', 'deploy'],
    ['staging', 'acquire'],
    ['staging', 'reserve'],
    ['staging', 'release'],
  ])
    assert.equal(check(installation, action, withNext), null, `${installation} ${action}`);
});

test('main-based branches, and branches behind main, may deploy to primary staging', () => {
  assert.equal(check('staging', 'deploy', main), null);
  assert.equal(check('staging', 'deploy', main, withNext), null);
});

test('anything that cannot be compared unambiguously fails closed', () => {
  const tagNotFirst = main.replace(
    /^\[\[migrations\]\][ \t]*\r?\n([ \t]*tag[ \t]*=[^\n]*)/m,
    '[[migrations]]\nnew_classes = ["X"]\n$1'
  );
  for (const [branch, base] of [
    ['', main],
    [withNext, ''],
    [tagNotFirst, main],
    ['name = "worker"\n', main],
  ])
    assert.throws(() => check('staging', 'deploy', branch, base), /wrangler\.toml|tag/);
});

test('the workflow entry point fetches main and fails closed', () => {
  const script = fileURLToPath(new URL('./staging-migration-guard.mjs', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'migration-guard-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    const origin = join(root, 'origin');
    mkdirSync(join(origin, 'apps/api'), { recursive: true });
    writeFileSync(join(origin, 'apps/api/wrangler.toml'), main);
    git(origin, 'init', '-q', '-b', 'main');
    git(
      origin,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'empty'
    );
    git(origin, 'add', '.');
    git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
    const branch = join(root, 'branch');
    git(root, 'clone', '-q', '--depth=1', `file://${origin}`, branch);
    const run = (installation = 'staging') =>
      spawnSync(process.execPath, [script], {
        cwd: branch,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: '',
          LEASE_ENVIRONMENT: installation,
          LEASE_ACTION: 'deploy',
        },
      });
    assert.equal(run().status, 0, run().stderr);
    appendFileSync(
      join(branch, 'apps/api/wrangler.toml'),
      `\n[[migrations]]\ntag = "${next}"\nnew_sqlite_classes = ["X"]\n`
    );
    const refused = run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`refused: .*${next}.*staging2`));
    assert.equal(run('staging2').status, 0);
    git(branch, 'remote', 'remove', 'origin'); // comparison impossible: fail closed
    assert.equal(run().status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
