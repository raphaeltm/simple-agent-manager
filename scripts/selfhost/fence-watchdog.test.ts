/**
 * The real sidecar loop with nft at its process boundary. The kernel observer (the reader
 * subprocess) is driven by a real `nft monitor` event that is released at a chosen point inside
 * ok publication, so the race is reproduced by ordering, not by timing.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, expect, it } from 'vitest';

const FENCE = resolve(import.meta.dirname, '../../deploy/selfhost/egress-fence/fence.sh');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * Stubs on PATH:
 * - nft: `-s list` prints the applied table; `monitor` waits for the `trigger` file, then emits one
 *   event naming the fence table (what the kernel prints on a ruleset change).
 * - flock: records each lock attempt, then runs the real flock.
 * - mv: logs whether the latch exists at every ok publication. With `race` set, the first
 *   publication releases the monitor event and waits until the reader has either latched
 *   (old fence: no lock) or reached the lock (fixed fence), so the latch lands between the
 *   publication's latch check and its mv.
 */
function startFence(race: boolean, { unopenableLock = false, failingFlock = false } = {}) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/fence-publication-'));
  const bin = join(dir, 'bin');
  const run = join(dir, 'run');
  mkdirSync(bin);
  mkdirSync(run);
  const attestation = join(run, 'attestation');
  const lost = join(run, 'lost');
  const rules = join(dir, 'rules.nft');
  const log = join(dir, 'publications.log');
  writeFileSync(rules, 'table inet sam_celld_egress {}\n');
  // A directory where the lock file belongs: every `9>>"$LOCK"` open fails.
  if (unopenableLock) mkdirSync(join(dir, 'applied.lock'));
  writeFileSync(
    join(bin, 'nft'),
    `#!/bin/sh
if [ "$1" = monitor ]; then
  while [ ! -f "$SAM_TEST_DIR/trigger" ]; do sleep 0.01; done
  echo 'delete table inet sam_celld_egress'
  exec sleep 300
fi
if [ "$1" = -s ]; then echo "table inet sam_celld_egress {}"; fi
`,
    { mode: 0o755 }
  );
  const realFlock = ['/usr/bin/flock', '/bin/flock'].find((path) => existsSync(path));
  if (!realFlock) throw new Error('flock is required (util-linux or busybox)');
  writeFileSync(
    join(bin, 'flock'),
    failingFlock
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\necho "$$" >>"$SAM_TEST_DIR/lock-attempts"\nexec ${realFlock} "$@"\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, 'mv'),
    `#!/bin/sh
if [ "$SAM_TEST_RACE" = 1 ] && [ ! -f "$SAM_TEST_DIR/trigger" ]; then
  : >"$SAM_TEST_DIR/trigger"
  i=0
  while [ ! -f "$SAM_TEST_LOST" ] &&
    [ "$(wc -l <"$SAM_TEST_DIR/lock-attempts" 2>/dev/null || echo 0)" -lt 2 ]; do
    i=$((i + 1))
    if [ "$i" -gt 1000 ]; then echo timeout >>"$SAM_TEST_DIR/publications.log"; break; fi
    sleep 0.01
  done
fi
if [ -f "$SAM_TEST_LOST" ]; then echo ok-while-lost >>"$SAM_TEST_DIR/publications.log"
else echo ok >>"$SAM_TEST_DIR/publications.log"; fi
exec /bin/mv "$@"
`,
    { mode: 0o755 }
  );
  const child = spawn('/bin/sh', [FENCE], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SAM_EGRESS_FENCE_RULES: rules,
      SAM_EGRESS_FENCE_STATE: join(dir, 'applied'),
      SAM_EGRESS_FENCE_ATTESTATION: attestation,
      SAM_EGRESS_FENCE_RECHECK_SECONDS: '0.01',
      SAM_TEST_DIR: dir,
      SAM_TEST_LOST: lost,
      SAM_TEST_RACE: race ? '1' : '0',
    },
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  cleanups.push(async () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    await new Promise<void>((done) =>
      child.exitCode !== null || child.signalCode !== null
        ? done()
        : child.once('exit', () => done())
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  return {
    attestation: () => read(attestation),
    latched: () => existsSync(lost),
    publications: () => read(log).split('\n').filter(Boolean),
    events: () => read(join(run, 'events.jsonl')),
    exited,
  };
}

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

it('never publishes ok once the kernel observer has latched, even mid-publication', async () => {
  const fence = startFence(true);
  await until(
    () => fence.latched() && fence.events().includes('egress_fence.lost'),
    'the reader to latch'
  );
  // Let the loop run many more passes after the latch; each would be a chance to publish ok.
  const eventsAtLatch = fence.events();
  await new Promise((done) => setTimeout(done, 300));
  expect(fence.events()).toContain('egress_fence.verified');
  expect(fence.events()).toContain('egress_fence.lost');
  expect(fence.events()).toBe(eventsAtLatch);
  // The raced publication was admitted before the latch and completed under the lock; nothing
  // was published while the latch existed, and the attestation reads lost from then on.
  expect(fence.publications()).not.toContain('timeout');
  expect(fence.publications()).not.toContain('ok-while-lost');
  expect(fence.publications()).toEqual(['ok']);
  expect(fence.attestation()).toBe('lost\n');
});

it('control: a healthy fence keeps publishing fresh ok', async () => {
  const fence = startFence(false);
  await until(() => fence.publications().length >= 5, 'five publications');
  expect(fence.latched()).toBe(false);
  expect(fence.publications().every((line) => line === 'ok')).toBe(true);
  expect(fence.attestation()).toMatch(/^ok \d+\n$/);
  expect(fence.events()).not.toContain('egress_fence.lost');
});

it.each([
  ['the lock cannot be opened', { unopenableLock: true }],
  ['flock fails on an open lock', { failingFlock: true }],
])('latches and stops when %s, publishing nothing', async (_name, failure) => {
  const fence = startFence(false, failure);
  expect(await fence.exited).toBe(1);
  expect(fence.events()).toContain('egress_fence.verified');
  expect(fence.events()).toContain('egress_fence.lost');
  expect(fence.latched()).toBe(true);
  expect(fence.publications()).toEqual([]);
  expect(fence.attestation()).toBe('lost\n');
});
