import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The managed builder is a minimal Debian container. A deploy script written for
// GitHub runners can assume tools the builder never installs: jq did exactly that
// and failed the first real full install at configure-services (staging,
// 2026-11-07). Every shell script the engine runs may only use command-line tools
// the builder bootstrap installs.
const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const OPTIONAL_TOOLS = [
  'jq',
  'yq',
  'aws',
  'gh',
  'unzip',
  'zip',
  'wget',
  'dig',
  'nslookup',
  'openssl',
  'xxd',
  'rsync',
];
const PACKAGE_FOR = { dig: 'dnsutils', nslookup: 'dnsutils', xxd: 'xxd' };

test('every engine shell script uses only tools the builder installs', () => {
  const engine = read('scripts/deploy/installer-engine.ts');
  const scripts = [...engine.matchAll(/script\('([^']+\.sh)'\)/g)].map((match) => match[1]);
  assert.ok(
    scripts.includes('configure-d1-read-replication.sh'),
    'engine scripts were not discovered'
  );
  const bootstrap = read('scripts/deploy/installer-builder-bootstrap.sh');
  const installed = new Set(
    [...bootstrap.matchAll(/apt-get install[^\n]*/g)].flatMap((match) => match[0].split(/\s+/))
  );
  const missing = [];
  for (const name of scripts) {
    const body = read(`scripts/deploy/${name}`)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const tool of OPTIONAL_TOOLS) {
      if (
        new RegExp(`(^|[\\s|($\`;])${tool}(\\s|$)`, 'm').test(body) &&
        !installed.has(PACKAGE_FOR[tool] || tool)
      )
        missing.push(`${name}: ${tool}`);
    }
  }
  assert.deepEqual(missing, []);
});
