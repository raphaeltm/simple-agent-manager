// Run in CI through scripts/quality/deploy-staging-permissions.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
