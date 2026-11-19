import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHILD_TEST_TIMEOUT_MS, runDeploy, writeBox } from './deploy-harness.js';

let dir: string;
let envFile: string;
let calls: string;
let env: NodeJS.ProcessEnv;
const active = [
  { Service: 'egress-fence', State: 'running' },
  { Service: 'celld', State: 'restarting' },
  { Service: 'gce-metadata-proxy', State: 'running' },
];
function serviceState(rows = active) {
  writeFileSync(join(dir, 'services.json'), JSON.stringify(rows));
}
function commands(): string[][] {
  return readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s) as string[]);
}
function operations(): string[][] {
  return commands().map((args) => args.slice(args.indexOf('--env-file') + 2));
}
async function init(extra: string[] = []) {
  envFile = writeBox(dir, [
    'COMPOSE_PROFILES=tunnel,gce',
    'CELLD_BUCKET=gs://fleet-bucket',
    ...extra,
  ]);
  return runDeploy(envFile, ['--init'], env);
}
beforeEach(() => {
  const scratch = resolve(import.meta.dirname, '../../.tmp');
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(join(scratch, 'sam-fence-reconcile-'));
  calls = join(dir, 'calls');
  writeFileSync(calls, '');
  mkdirSync(join(dir, 'bin'));
  // Only the external Compose boundary is replaced. Deploy parsing, state generation and
  // reconciliation run unchanged in the real child entry point.
  writeFileSync(
    join(dir, 'bin/docker'),
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FENCE_CALLS, JSON.stringify(args) + '\\n');
if (process.env.SAM_SELFHOST_STATE_DIR !== process.env.FENCE_STATE) process.exit(90);
if (args.includes('ps') && fs.existsSync(process.env.FENCE_BAD_PS)) { process.stdout.write('untrusted invalid state'); process.exit(0); }
if (args.includes('ps')) { process.stdout.write(fs.readFileSync(process.env.FENCE_SERVICES)); process.exit(0); }
if (args.includes('up') && fs.existsSync(process.env.FENCE_FAIL)) process.exit(1);
`,
    { mode: 0o755 }
  );
  env = {
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    FENCE_CALLS: calls,
    FENCE_STATE: join(dir, '.state'),
    FENCE_SERVICES: join(dir, 'services.json'),
    FENCE_FAIL: join(dir, 'fail'),
    FENCE_BAD_PS: join(dir, 'bad-ps'),
  };
  serviceState();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe(
  'ordinary deploy reconciles generated fence inputs',
  { timeout: CHILD_TEST_TIMEOUT_MS },
  () => {
    it('fresh --init only generates files, even when Docker would report an active project', async () => {
      const result = await init();
      expect(result.status, result.out).toBe(0);
      expect(commands()).toEqual([]);
      expect(readFileSync(join(dir, '.state/egress-fence.nft'), 'utf8')).toContain(
        'sam_celld_egress'
      );
    });

    it('recreates the fence before recovering a restarting celld on existing --init', async () => {
      expect((await init()).status).toBe(0);
      const result = await init(['SAM_EGRESS_ALLOW=192.168.44.1:8000']);
      expect(result.status, result.out).toBe(0);
      expect(operations()).toEqual([
        ['ps', '--all', '--format', 'json'],
        ['stop', 'celld'],
        ['up', '-d', '--no-deps', '--force-recreate', '--wait', 'egress-fence'],
        ['up', '-d', '--no-deps', '--force-recreate', '--wait', 'gce-metadata-proxy'],
        ['run', '--rm', '--no-deps', 'celld-data-owner'],
        ['up', '-d', '--no-deps', '--force-recreate', '--wait', 'celld'],
      ]);
    });

    it('ordinary deploy reloads env-only changes into proxy and celld without recreating the fence', async () => {
      expect((await init()).status).toBe(0);
      envFile = writeBox(dir, [
        'COMPOSE_PROFILES=tunnel,gce',
        'CELLD_BUCKET=gs://fleet-bucket',
        'GCE_METADATA_PROXY_SCOPES=https://www.googleapis.com/auth/devstorage.read_only',
      ]);
      // Stop later deployment work at the normal secrets validation boundary, after reconciliation.
      writeFileSync(join(dir, '.state/secrets.env'), 'SAM_INSTALLATION_ID=wrong\n', {
        mode: 0o600,
      });
      const result = await runDeploy(envFile, ['--skip-vm-agent'], env);
      expect(result.status).toBe(1);
      expect(result.out).toContain('SAM_INSTALLATION_ID differs');
      expect(operations()).toEqual([
        ['ps', '--all', '--format', 'json'],
        ['stop', 'celld'],
        ['up', '-d', '--no-deps', '--force-recreate', '--wait', 'gce-metadata-proxy'],
        ['up', '-d', '--no-deps', '--force-recreate', '--wait', 'celld'],
      ]);
    });

    it.each(['missing', 'stopped'] as const)(
      'enabling GCE for an active S3 installation handles a %s proxy',
      async (proxyState) => {
        expect(
          (await init(['COMPOSE_PROFILES=tunnel,local-store', 'CELLD_BUCKET=s3://fleet/celld']))
            .status
        ).toBe(0);
        serviceState(
          active
            .filter((row) => row.Service !== 'gce-metadata-proxy')
            .concat(
              proxyState === 'stopped' ? [{ Service: 'gce-metadata-proxy', State: 'exited' }] : []
            )
        );
        const result = await init();
        expect(result.status, result.out).toBe(0);
        const ops = operations();
        const proxy = ops.findIndex(
          (args) => args.includes('up') && args.includes('gce-metadata-proxy')
        );
        const celld = ops.findIndex((args) => args.includes('up') && args.includes('celld'));
        expect(celld).toBeGreaterThan(0);
        if (proxyState === 'missing') {
          expect(proxy).toBeGreaterThan(0);
          expect(proxy).toBeLessThan(celld);
        } else {
          expect(proxy).toBe(-1);
        }
      }
    );

    it('retains a newly required proxy across a failed GCE transition retry', async () => {
      expect(
        (await init(['COMPOSE_PROFILES=tunnel,local-store', 'CELLD_BUCKET=s3://fleet/celld']))
          .status
      ).toBe(0);
      serviceState(active.filter((row) => row.Service !== 'gce-metadata-proxy'));
      writeFileSync(join(dir, 'fail'), 'fail');
      expect((await init()).status).toBe(1);
      const pending = JSON.parse(
        readFileSync(join(dir, '.state/fence-reconcile-pending.json'), 'utf8')
      );
      expect(pending.proxy).toBe(true);
      rmSync(join(dir, 'fail'));
      serviceState(
        active
          .filter((row) => row.Service !== 'gce-metadata-proxy')
          .map((row) => ({ ...row, State: 'exited' }))
      );
      writeFileSync(calls, '');
      expect((await init()).status).toBe(0);
      expect(operations()).toContainEqual([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'gce-metadata-proxy',
      ]);
    });

    it('unchanged inputs inspect but never restart services', async () => {
      expect((await init()).status).toBe(0);
      expect((await init()).status).toBe(0);
      expect(operations()).toEqual([['ps', '--all', '--format', 'json']]);
    });

    it('a deliberately stopped installation stays stopped after input changes', async () => {
      expect((await init()).status).toBe(0);
      serviceState(active.map((row) => ({ ...row, State: 'exited' })));
      expect((await init(['SAM_EGRESS_ALLOW=192.168.44.1:8000'])).status).toBe(0);
      expect(operations()).toEqual([['ps', '--all', '--format', 'json']]);
      serviceState();
      writeFileSync(calls, '');
      expect((await init(['SAM_EGRESS_ALLOW=192.168.44.1:8000'])).status).toBe(0);
      expect(operations()).toContainEqual([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'egress-fence',
      ]);
    });

    it('failed reconciliation aborts, stops credential consumers and retries unchanged files', async () => {
      expect((await init()).status).toBe(0);
      writeFileSync(join(dir, 'fail'), 'fail');
      const failed = await init(['SAM_EGRESS_ALLOW=192.168.44.1:8000']);
      expect(failed.status).toBe(1);
      expect(failed.out).toContain('fence reconciliation failed');
      expect(operations()).toContainEqual(['stop', 'celld', 'gce-metadata-proxy']);
      expect(operations()).not.toContainEqual([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'celld',
      ]);
      rmSync(join(dir, 'fail'));
      serviceState(active.map((row) => ({ ...row, State: 'exited' })));
      writeFileSync(calls, '');
      expect((await init(['SAM_EGRESS_ALLOW=192.168.44.1:8000'])).status).toBe(0);
      expect(operations()).toContainEqual([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'egress-fence',
      ]);
      expect(operations()).toContainEqual([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'celld',
      ]);
    });
    it('recovers original consumer intent after process exit immediately following a rules write', async () => {
      expect((await init()).status).toBe(0);
      const rulesPath = join(dir, '.state/egress-fence.nft');
      const oldRules = readFileSync(rulesPath, 'utf8');
      const oldEnv = readFileSync(join(dir, '.state/celld.env'), 'utf8');
      // Intercept only the external filesystem write, after the real write succeeds.
      // An abrupt process exit cannot execute reconciliation or its error handler.
      const crashModule = join(dir, 'crash-after-write.mjs');
      writeFileSync(
        crashModule,
        `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.writeFileSync;
fs.writeFileSync = function(path, ...args) {
  const result = original.call(this, path, ...args);
  if (String(path) === process.env.FENCE_CRASH_PATH) process.exit(77);
  return result;
};
syncBuiltinESMExports();
`
      );
      envFile = writeBox(dir, [
        'COMPOSE_PROFILES=tunnel,gce',
        'CELLD_BUCKET=gs://fleet-bucket',
        'SAM_EGRESS_ALLOW=192.168.44.1:8000',
      ]);
      const interrupted = await runDeploy(envFile, ['--init'], {
        ...env,
        NODE_OPTIONS: `--import=${crashModule}`,
        FENCE_CRASH_PATH: rulesPath,
      });
      expect(interrupted.status, interrupted.out).toBe(77);
      expect(readFileSync(rulesPath, 'utf8')).not.toBe(oldRules);
      expect(readFileSync(join(dir, '.state/celld.env'), 'utf8')).toBe(oldEnv);
      expect(operations()).toEqual([['ps', '--all', '--format', 'json']]);
      const pending = JSON.parse(
        readFileSync(join(dir, '.state/fence-reconcile-pending.json'), 'utf8')
      );
      expect(pending.rules).toBe(true);
      expect(pending.celld).toBe(true);
      serviceState(active.map((row) => ({ ...row, State: 'exited' })));
      writeFileSync(calls, '');
      const retry = await runDeploy(envFile, ['--init'], env);
      expect(retry.status, retry.out).toBe(0);
      expect(operations()).toContainEqual([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'egress-fence',
      ]);
      expect(operations()).toContainEqual([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'celld',
      ]);
    });

    it('refuses invalid discovery before mutating an existing ruleset', async () => {
      expect((await init()).status).toBe(0);
      const rules = readFileSync(join(dir, '.state/egress-fence.nft'), 'utf8');
      writeFileSync(join(dir, 'bad-ps'), 'fail');
      const result = await init(['SAM_EGRESS_ALLOW=192.168.44.1:8000']);
      expect(result.status).toBe(1);
      expect(result.out).toContain('invalid Compose service state');
      expect(result.out).not.toContain('untrusted invalid state');
      expect(readFileSync(join(dir, '.state/egress-fence.nft'), 'utf8')).toBe(rules);
    });

    it('bounds Compose discovery and leaves files unchanged on timeout', async () => {
      expect((await init()).status).toBe(0);
      const rules = readFileSync(join(dir, '.state/egress-fence.nft'), 'utf8');
      const result = await runDeploy(envFile, ['--init'], {
        ...env,
        SELFHOST_COMPOSE_TIMEOUT_MS: '1',
      });
      expect(result.status).toBe(1);
      expect(result.out).toContain('Compose command failed');
      expect(readFileSync(join(dir, '.state/egress-fence.nft'), 'utf8')).toBe(rules);
    });
    it('stops the old proxy when the GCE profile is disabled', async () => {
      expect((await init()).status).toBe(0);
      const result = await init([
        'COMPOSE_PROFILES=tunnel,local-store',
        'CELLD_BUCKET=s3://fleet/celld',
      ]);
      expect(result.status, result.out).toBe(0);
      expect(operations()).toContainEqual(['stop', 'gce-metadata-proxy']);
      expect(operations()).not.toContainEqual([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'gce-metadata-proxy',
      ]);
    });
    it('keeps deliberately stopped consumers stopped while the fence is active', async () => {
      expect((await init()).status).toBe(0);
      serviceState(
        active.map((row) => (row.Service === 'egress-fence' ? row : { ...row, State: 'exited' }))
      );
      expect((await init(['SAM_EGRESS_ALLOW=192.168.44.1:8000'])).status).toBe(0);
      expect(operations()).toEqual([
        ['ps', '--all', '--format', 'json'],
        ['up', '-d', '--no-deps', '--force-recreate', '--wait', 'egress-fence'],
      ]);
    });

    it.each(['0', '60000junk'])(
      'rejects invalid box reconciliation timeout %s before writing rules',
      async (timeout) => {
        expect((await init()).status).toBe(0);
        const rules = readFileSync(join(dir, '.state/egress-fence.nft'), 'utf8');
        const result = await init([
          'SAM_EGRESS_ALLOW=192.168.44.1:8000',
          `SELFHOST_COMPOSE_TIMEOUT_MS=${timeout}`,
        ]);
        expect(result.status).toBe(1);
        expect(result.out).toContain('SELFHOST_COMPOSE_TIMEOUT_MS must be a positive integer');
        expect(commands()).toEqual([]);
        expect(readFileSync(join(dir, '.state/egress-fence.nft'), 'utf8')).toBe(rules);
      }
    );

    it.each(['running', 'exited'])(
      'updates UID ownership while preserving a %s metadata proxy intent',
      async (proxyState) => {
        expect((await init()).status).toBe(0);
        serviceState(
          active.map((row) =>
            row.Service === 'gce-metadata-proxy' ? { ...row, State: proxyState } : row
          )
        );
        const oldEnv = readFileSync(join(dir, '.state/celld.env'), 'utf8');
        expect((await init(['CELLD_UID=7203'])).status).toBe(0);
        // This must exercise the UID-only path, not an incidental env change.
        expect(readFileSync(join(dir, '.state/celld.env'), 'utf8')).toBe(oldEnv);
        const ops = operations();
        const owner = ops.findIndex((args) => args.includes('celld-data-owner'));
        const celld = ops.findIndex((args) => args.includes('up') && args.includes('celld'));
        const proxy = ops.findIndex(
          (args) => args.includes('up') && args.includes('gce-metadata-proxy')
        );
        expect(owner).toBeGreaterThan(0);
        expect(celld).toBeGreaterThan(owner);
        if (proxyState === 'running') {
          expect(proxy).toBeGreaterThan(0);
          expect(proxy).toBeLessThan(celld);
        } else {
          expect(proxy).toBe(-1);
        }
        expect(readFileSync(join(dir, '.state/egress-fence.nft'), 'utf8')).toContain('7203');
      }
    );
  }
);
